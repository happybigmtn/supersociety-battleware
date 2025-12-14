use commonware_codec::{Decode, DecodeExt};
use commonware_cryptography::{
    bls12381::primitives::{group, poly, variant::MinSig},
    ed25519::{PrivateKey, PublicKey},
    Signer,
};
use commonware_utils::{from_hex_formatted, quorum};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::SocketAddr, path::PathBuf, str::FromStr};
use thiserror::Error;
use tracing::Level;

use nullspace_types::{Evaluation, Identity};

pub mod aggregator;
pub mod application;
pub mod engine;
pub mod indexer;
pub mod seeder;
pub mod supervisor;

/// Configuration for the [engine::Engine].
#[derive(Deserialize, Serialize)]
pub struct Config {
    pub private_key: String,
    pub share: String,
    pub polynomial: String,

    pub port: u16,
    pub metrics_port: u16,
    pub directory: String,
    pub worker_threads: usize,
    pub log_level: String,

    pub allowed_peers: Vec<String>,
    pub bootstrappers: Vec<String>,

    pub message_backlog: usize,
    pub mailbox_size: usize,
    pub deque_size: usize,
    #[serde(default = "default_mempool_max_backlog")]
    pub mempool_max_backlog: usize,
    #[serde(default = "default_mempool_max_transactions")]
    pub mempool_max_transactions: usize,

    pub indexer: String,
    pub execution_concurrency: usize,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("{field} must be hex: {value}")]
    InvalidHex { field: &'static str, value: String },
    #[error("{field} is invalid: {value}")]
    InvalidDecode {
        field: &'static str,
        value: String,
        #[source]
        source: commonware_codec::Error,
    },
    #[error("invalid log level: {value}")]
    InvalidLogLevel { value: String },
    #[error("{field} must be > 0 (got {value})")]
    InvalidNonZero { field: &'static str, value: usize },
}

pub struct ValidatedConfig {
    pub signer: PrivateKey,
    pub public_key: PublicKey,
    pub share: group::Share,
    pub polynomial: poly::Poly<Evaluation>,
    pub identity: Identity,

    pub port: u16,
    pub metrics_port: u16,
    pub directory: PathBuf,
    pub worker_threads: usize,
    pub log_level: Level,

    pub allowed_peers: Vec<String>,
    pub bootstrappers: Vec<String>,

    pub message_backlog: usize,
    pub mailbox_size: usize,
    pub deque_size: usize,
    pub mempool_max_backlog: usize,
    pub mempool_max_transactions: usize,

    pub indexer: String,
    pub execution_concurrency: usize,
}

fn default_mempool_max_backlog() -> usize {
    64
}

fn default_mempool_max_transactions() -> usize {
    100_000
}

fn parse_hex(field: &'static str, value: &str) -> Result<Vec<u8>, ConfigError> {
    from_hex_formatted(value).ok_or(ConfigError::InvalidHex {
        field,
        value: value.to_string(),
    })
}

fn decode_hex<T: DecodeExt<()>>(field: &'static str, value: &str) -> Result<T, ConfigError> {
    let bytes = parse_hex(field, value)?;
    T::decode(bytes.as_ref()).map_err(|source| ConfigError::InvalidDecode {
        field,
        value: value.to_string(),
        source,
    })
}

pub fn parse_peer_public_key(name: &str) -> Option<PublicKey> {
    from_hex_formatted(name).and_then(|key| PublicKey::decode(key.as_ref()).ok())
}

impl Config {
    pub fn parse_signer(&self) -> Result<PrivateKey, ConfigError> {
        decode_hex("private_key", &self.private_key)
    }

    pub fn validate(self, peer_count: u32) -> Result<ValidatedConfig, ConfigError> {
        let signer = self.parse_signer()?;
        self.validate_with_signer(signer, peer_count)
    }

    pub fn validate_with_signer(
        self,
        signer: PrivateKey,
        peer_count: u32,
    ) -> Result<ValidatedConfig, ConfigError> {
        if self.mempool_max_backlog == 0 {
            return Err(ConfigError::InvalidNonZero {
                field: "mempool_max_backlog",
                value: self.mempool_max_backlog,
            });
        }
        if self.mempool_max_transactions == 0 {
            return Err(ConfigError::InvalidNonZero {
                field: "mempool_max_transactions",
                value: self.mempool_max_transactions,
            });
        }

        let public_key = signer.public_key();

        let share = decode_hex("share", &self.share)?;

        let threshold = quorum(peer_count);
        let polynomial_bytes = parse_hex("polynomial", &self.polynomial)?;
        let polynomial =
            poly::Public::<MinSig>::decode_cfg(polynomial_bytes.as_ref(), &(threshold as usize))
                .map_err(|source| ConfigError::InvalidDecode {
                    field: "polynomial",
                    value: self.polynomial.clone(),
                    source,
                })?;
        let identity = *poly::public::<MinSig>(&polynomial);

        let log_level =
            Level::from_str(&self.log_level).map_err(|_| ConfigError::InvalidLogLevel {
                value: self.log_level.clone(),
            })?;

        Ok(ValidatedConfig {
            signer,
            public_key,
            share,
            polynomial,
            identity,
            port: self.port,
            metrics_port: self.metrics_port,
            directory: PathBuf::from(self.directory),
            worker_threads: self.worker_threads,
            log_level,
            allowed_peers: self.allowed_peers,
            bootstrappers: self.bootstrappers,
            message_backlog: self.message_backlog,
            mailbox_size: self.mailbox_size,
            deque_size: self.deque_size,
            mempool_max_backlog: self.mempool_max_backlog,
            mempool_max_transactions: self.mempool_max_transactions,
            indexer: self.indexer,
            execution_concurrency: self.execution_concurrency,
        })
    }
}

/// A list of peers provided when a validator is run locally.
///
/// When run remotely, [commonware_deployer::ec2::Hosts] is used instead.
#[derive(Deserialize, Serialize)]
pub struct Peers {
    pub addresses: HashMap<String, SocketAddr>,
}

#[cfg(test)]
mod tests;
