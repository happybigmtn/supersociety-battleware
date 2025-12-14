use crate::{events::Stream, Error, Result};
use commonware_codec::{DecodeExt, Encode};
use commonware_cryptography::{Hasher, Sha256};
use commonware_utils::hex;
use nullspace_types::{
    api::{
        Lookup, Pending, Submission, Summary, Update, UpdatesFilter, MAX_SUBMISSION_TRANSACTIONS,
    },
    execution::{Key, Seed, Transaction},
    Identity,
};
use reqwest::Client as HttpClient;
use std::time::Duration;
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;
use tracing::{debug, info};
use url::Url;

/// Timeout for connections and requests
const TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn join_hex_path(base: &Url, prefix: &str, bytes: &[u8]) -> Result<Url> {
    Ok(base.join(&format!("{prefix}/{}", hex(bytes)))?)
}

/// Retry policy for transient HTTP failures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Total attempts per request (including the first attempt).
    pub max_attempts: usize,
    /// Initial backoff delay after the first retryable failure.
    pub initial_backoff: Duration,
    /// Maximum backoff delay between attempts.
    pub max_backoff: Duration,
    /// Whether non-idempotent requests (e.g., POST) may be retried.
    pub retry_non_idempotent: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 1,
            initial_backoff: Duration::from_millis(200),
            max_backoff: Duration::from_secs(2),
            retry_non_idempotent: false,
        }
    }
}

/// Nullspace API client
#[derive(Clone)]
pub struct Client {
    pub base_url: Url,
    pub ws_url: Url,
    pub http_client: HttpClient,

    pub identity: Identity,

    retry_policy: RetryPolicy,
}

impl Client {
    /// Create a new client
    #[allow(clippy::result_large_err)]
    pub fn new(base_url: &str, identity: Identity) -> Result<Self> {
        let base_url = Url::parse(base_url)?;

        // Convert http(s) to ws(s) for WebSocket URL
        let ws_scheme = match base_url.scheme() {
            "http" => "ws",
            "https" => "wss",
            scheme => {
                return Err(Error::InvalidScheme(scheme.to_string()));
            }
        };

        let mut ws_url = base_url.clone();
        ws_url
            .set_scheme(ws_scheme)
            .map_err(|_| Error::InvalidScheme(ws_scheme.to_string()))?;

        let http_client = HttpClient::builder()
            .timeout(TIMEOUT)
            .pool_max_idle_per_host(100) // More connections per host
            .pool_idle_timeout(Duration::from_secs(60)) // Keep connections alive
            .tcp_keepalive(Duration::from_secs(30)) // TCP keepalive
            .build()?;

        Ok(Self {
            base_url,
            ws_url,
            http_client,
            identity,
            retry_policy: RetryPolicy::default(),
        })
    }

    /// Returns a copy of the current retry policy.
    pub fn retry_policy(&self) -> RetryPolicy {
        self.retry_policy
    }

    /// Sets the retry policy for subsequent HTTP requests.
    pub fn set_retry_policy(&mut self, retry_policy: RetryPolicy) {
        self.retry_policy = retry_policy;
    }

    /// Returns a new client with the provided retry policy.
    pub fn with_retry_policy(mut self, retry_policy: RetryPolicy) -> Self {
        self.retry_policy = retry_policy;
        self
    }

    pub(crate) async fn get_with_retry(&self, url: Url) -> Result<reqwest::Response> {
        self.send_with_retry(reqwest::Method::GET, || self.http_client.get(url.clone()))
            .await
    }

    pub(crate) async fn post_bytes_with_retry(&self, url: Url, body: Vec<u8>) -> Result<()> {
        let response = self
            .send_with_retry(reqwest::Method::POST, || {
                self.http_client.post(url.clone()).body(body.clone())
            })
            .await?;
        if !response.status().is_success() {
            return Err(Error::Failed(response.status()));
        }
        Ok(())
    }

    async fn send_with_retry(
        &self,
        method: reqwest::Method,
        make_request: impl Fn() -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response> {
        let max_attempts =
            if method == reqwest::Method::GET || self.retry_policy.retry_non_idempotent {
                self.retry_policy.max_attempts.max(1)
            } else {
                1
            };

        let mut attempt = 0usize;
        let mut backoff = self.retry_policy.initial_backoff;
        loop {
            attempt += 1;
            let result = make_request().send().await;
            match result {
                Ok(response) => {
                    let status = response.status();
                    if !is_retryable_status(status) || attempt >= max_attempts {
                        return Ok(response);
                    }
                }
                Err(err) => {
                    if attempt >= max_attempts || !is_retryable_error(&err) {
                        return Err(Error::Reqwest(err));
                    }
                }
            }

            if backoff > Duration::ZERO {
                sleep(backoff).await;
                backoff = std::cmp::min(backoff.saturating_mul(2), self.retry_policy.max_backoff);
            }
        }
    }

    /// Submit a transaction
    pub async fn submit_transactions(&self, txs: Vec<Transaction>) -> Result<()> {
        if txs.len() > MAX_SUBMISSION_TRANSACTIONS {
            return Err(Error::TooManyTransactions {
                max: MAX_SUBMISSION_TRANSACTIONS,
                got: txs.len(),
            });
        }
        let submission = Submission::Transactions(txs);
        self.submit(submission).await
    }

    pub async fn submit_summary(&self, summary: Summary) -> Result<()> {
        let submission = Submission::Summary(summary);
        self.submit(submission).await
    }

    pub async fn submit_seed(&self, seed: Seed) -> Result<()> {
        let submission = Submission::Seed(seed);
        self.submit(submission).await
    }

    async fn submit(&self, submission: Submission) -> Result<()> {
        let encoded = submission.encode();
        let url = self.base_url.join("submit")?;
        debug!("Submitting to {}", url);

        self.post_bytes_with_retry(url, encoded.to_vec()).await
    }

    /// Query state by key
    pub async fn query_state(&self, key: &Key) -> Result<Option<Lookup>> {
        // Make request
        let key_hash = Sha256::hash(&key.encode());
        let url = join_hex_path(&self.base_url, "state", &key_hash.encode())?;
        let response = self.get_with_retry(url).await?;

        // Parse response
        match response.status() {
            reqwest::StatusCode::OK => {
                let buf = response.bytes().await?.to_vec();
                let lookup = Lookup::decode(&mut buf.as_slice())?;

                // Verify the lookup
                if let Err(err) = lookup.verify(&self.identity) {
                    debug!(?err, "Lookup verification failed");
                    return Err(Error::InvalidSignature);
                }

                Ok(Some(lookup))
            }
            reqwest::StatusCode::NOT_FOUND => Ok(None),
            _ => Err(Error::Failed(response.status())),
        }
    }

    /// Connect to the updates stream with the specified filter
    pub async fn connect_updates(&self, filter: UpdatesFilter) -> Result<Stream<Update>> {
        let encoded_filter = hex(&filter.encode());
        let ws_url = self.ws_url.join(&format!("updates/{encoded_filter}"))?;
        info!(ws_url = %ws_url, ?filter, encoded_filter = %encoded_filter, "Connecting to updates WebSocket");

        let (ws_stream, _) = timeout(TIMEOUT, connect_async(ws_url.as_str()))
            .await
            .map_err(|_| Error::DialTimeout)??;
        info!("WebSocket connected");

        Ok(Stream::new_with_verifier(ws_stream, self.identity))
    }

    /// Connect to the updates stream with a configurable channel capacity.
    ///
    /// A `channel_capacity` of `0` uses the default capacity.
    pub async fn connect_updates_with_capacity(
        &self,
        filter: UpdatesFilter,
        channel_capacity: usize,
    ) -> Result<Stream<Update>> {
        let encoded_filter = hex(&filter.encode());
        let ws_url = self.ws_url.join(&format!("updates/{encoded_filter}"))?;
        info!(ws_url = %ws_url, ?filter, encoded_filter = %encoded_filter, "Connecting to updates WebSocket");

        let (ws_stream, _) = timeout(TIMEOUT, connect_async(ws_url.as_str()))
            .await
            .map_err(|_| Error::DialTimeout)??;
        info!("WebSocket connected");

        Ok(Stream::new_with_verifier_with_capacity(
            ws_stream,
            self.identity,
            channel_capacity,
        ))
    }

    /// Connect to the mempool stream (transactions)
    pub async fn connect_mempool(&self) -> Result<Stream<Pending>> {
        let ws_url = self.ws_url.join("mempool")?;
        info!("Connecting to WebSocket at {}", ws_url);

        let (ws_stream, _) = timeout(TIMEOUT, connect_async(ws_url.as_str()))
            .await
            .map_err(|_| Error::DialTimeout)??;
        info!("WebSocket connected");

        Ok(Stream::new(ws_stream))
    }

    /// Connect to the mempool stream (transactions) with a configurable channel capacity.
    ///
    /// A `channel_capacity` of `0` uses the default capacity.
    pub async fn connect_mempool_with_capacity(
        &self,
        channel_capacity: usize,
    ) -> Result<Stream<Pending>> {
        let ws_url = self.ws_url.join("mempool")?;
        info!("Connecting to WebSocket at {}", ws_url);

        let (ws_stream, _) = timeout(TIMEOUT, connect_async(ws_url.as_str()))
            .await
            .map_err(|_| Error::DialTimeout)??;
        info!("WebSocket connected");

        Ok(Stream::new_with_capacity(ws_stream, channel_capacity))
    }
}

fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    use reqwest::StatusCode;
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

fn is_retryable_error(err: &reqwest::Error) -> bool {
    err.is_connect() || err.is_timeout()
}
