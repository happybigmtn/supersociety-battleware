use bytes::{Buf, BufMut};
use commonware_codec::{Encode, EncodeSize, Error, Read, ReadExt, Write};
use commonware_cryptography::{
    ed25519::PublicKey,
    sha256::{Digest, Sha256},
    Hasher,
};
use commonware_runtime::{Clock, Metrics, Spawner, Storage};
use commonware_storage::{adb::any::variable::Any, translator::Translator};
use nullspace_types::execution::{Account, Key, Transaction, Value};
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
};
use tracing::warn;

pub type Adb<E, T> = Any<E, Digest, Value, Sha256, T>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrepareError {
    NonceMismatch { expected: u64, got: u64 },
}

pub trait State {
    fn get(&self, key: &Key) -> impl Future<Output = Option<Value>>;
    fn insert(&mut self, key: Key, value: Value) -> impl Future<Output = ()>;
    fn delete(&mut self, key: &Key) -> impl Future<Output = ()>;

    fn apply(&mut self, changes: Vec<(Key, Status)>) -> impl Future<Output = ()> {
        async {
            for (key, status) in changes {
                match status {
                    Status::Update(value) => self.insert(key, value).await,
                    Status::Delete => self.delete(&key).await,
                }
            }
        }
    }
}

impl<E: Spawner + Metrics + Clock + Storage, T: Translator> State for Adb<E, T> {
    async fn get(&self, key: &Key) -> Option<Value> {
        let key = Sha256::hash(&key.encode());
        match self.get(&key).await {
            Ok(value) => value,
            Err(e) => {
                warn!("Database error during get operation: {:?}", e);
                None
            }
        }
    }

    async fn insert(&mut self, key: Key, value: Value) {
        let key = Sha256::hash(&key.encode());
        if let Err(e) = self.update(key, value).await {
            warn!("Database error during insert operation: {:?}", e);
        }
    }

    async fn delete(&mut self, key: &Key) {
        let key = Sha256::hash(&key.encode());
        if let Err(e) = self.delete(key).await {
            warn!("Database error during delete operation: {:?}", e);
        }
    }
}

#[derive(Default)]
pub struct Memory {
    state: HashMap<Key, Value>,
}

impl State for Memory {
    async fn get(&self, key: &Key) -> Option<Value> {
        self.state.get(key).cloned()
    }

    async fn insert(&mut self, key: Key, value: Value) {
        self.state.insert(key, value);
    }

    async fn delete(&mut self, key: &Key) {
        self.state.remove(key);
    }
}

#[derive(Clone)]
#[allow(clippy::large_enum_variant)]
pub enum Status {
    Update(Value),
    Delete,
}

impl Write for Status {
    fn write(&self, writer: &mut impl BufMut) {
        match self {
            Status::Update(value) => {
                0u8.write(writer);
                value.write(writer);
            }
            Status::Delete => 1u8.write(writer),
        }
    }
}

impl Read for Status {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let kind = u8::read(reader)?;
        match kind {
            0 => Ok(Status::Update(Value::read(reader)?)),
            1 => Ok(Status::Delete),
            _ => Err(Error::InvalidEnum(kind)),
        }
    }
}

impl EncodeSize for Status {
    fn encode_size(&self) -> usize {
        1 + match self {
            Status::Update(value) => value.encode_size(),
            Status::Delete => 0,
        }
    }
}

pub async fn nonce<S: State>(state: &S, public: &PublicKey) -> u64 {
    load_account(state, public).await.nonce
}

pub(crate) async fn load_account<S: State>(state: &S, public: &PublicKey) -> Account {
    match state.get(&Key::Account(public.clone())).await {
        Some(Value::Account(account)) => account,
        _ => Account::default(),
    }
}

pub(crate) fn validate_and_increment_nonce(
    account: &mut Account,
    provided_nonce: u64,
) -> Result<(), PrepareError> {
    if account.nonce != provided_nonce {
        return Err(PrepareError::NonceMismatch {
            expected: account.nonce,
            got: provided_nonce,
        });
    }
    account.nonce += 1;
    Ok(())
}

pub struct Noncer<'a, S: State> {
    state: &'a S,
    pending: BTreeMap<Key, Status>,
}

impl<'a, S: State> Noncer<'a, S> {
    pub fn new(state: &'a S) -> Self {
        Self {
            state,
            pending: BTreeMap::new(),
        }
    }

    pub async fn prepare(&mut self, transaction: &Transaction) -> Result<(), PrepareError> {
        let mut account = load_account(self, &transaction.public).await;
        validate_and_increment_nonce(&mut account, transaction.nonce)?;
        self.insert(
            Key::Account(transaction.public.clone()),
            Value::Account(account),
        )
        .await;

        Ok(())
    }
}

impl<'a, S: State> State for Noncer<'a, S> {
    async fn get(&self, key: &Key) -> Option<Value> {
        match self.pending.get(key) {
            Some(Status::Update(value)) => Some(value.clone()),
            Some(Status::Delete) => None,
            None => self.state.get(key).await,
        }
    }

    async fn insert(&mut self, key: Key, value: Value) {
        self.pending.insert(key, Status::Update(value));
    }

    async fn delete(&mut self, key: &Key) {
        self.pending.insert(key.clone(), Status::Delete);
    }
}
