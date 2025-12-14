use crate::{client::join_hex_path, Client, Error, Result};
use commonware_codec::{DecodeExt, Encode};
use commonware_consensus::Viewable;
use nullspace_types::{api::Query, Seed, NAMESPACE};

impl Client {
    pub async fn query_seed(&self, query: Query) -> Result<Option<Seed>> {
        // Make request
        let url = join_hex_path(&self.base_url, "seed", &query.encode())?;
        let result = self.get_with_retry(url).await?;

        // Parse response
        match result.status() {
            reqwest::StatusCode::NOT_FOUND => Ok(None),
            reqwest::StatusCode::OK => {
                let bytes = result.bytes().await.map_err(Error::Reqwest)?;
                let seed = Seed::decode(bytes.as_ref()).map_err(Error::InvalidData)?;
                if !seed.verify(NAMESPACE, &self.identity) {
                    return Err(Error::InvalidSignature);
                }

                // Verify the seed matches the query
                match query {
                    Query::Latest => {}
                    Query::Index(index) => {
                        if seed.view() != index {
                            return Err(Error::UnexpectedResponse);
                        }
                    }
                }
                Ok(Some(seed))
            }
            _ => Err(Error::Failed(result.status())),
        }
    }
}
