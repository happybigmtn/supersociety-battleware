use bytes::Bytes;
use commonware_consensus::{
    threshold_simplex::types::{Seedable, View},
    Reporter,
};
use commonware_macros::select;
use commonware_resolver::{p2p::Producer, Consumer};
use commonware_runtime::signal::Signal;
use commonware_utils::sequence::U64;
use futures::{
    channel::{mpsc, oneshot},
    SinkExt,
};
use nullspace_types::{Activity, Seed};
use thiserror::Error;
use tracing::warn;

pub enum Message {
    Put(Seed),
    Get {
        view: View,
        response: oneshot::Sender<Seed>,
    },
    Deliver {
        view: View,
        signature: Bytes,
        response: oneshot::Sender<bool>,
    },
    Produce {
        view: View,
        response: oneshot::Sender<Bytes>,
    },
    Uploaded {
        view: View,
    },
}

#[derive(Clone)]
pub struct Mailbox {
    sender: mpsc::Sender<Message>,
    stopped: Signal,
}

#[derive(Debug, Error)]
pub enum MailboxError {
    #[error("seeder mailbox closed")]
    Closed,
    #[error("seeder request canceled")]
    Canceled,
    #[error("shutdown in progress")]
    ShuttingDown,
}

impl Mailbox {
    pub(super) fn new(sender: mpsc::Sender<Message>, stopped: Signal) -> Self {
        Self { sender, stopped }
    }

    pub async fn put(&mut self, seed: Seed) -> Result<(), MailboxError> {
        let mut sender = self.sender.clone();
        let mut stopped = self.stopped.clone();
        select! {
            result = sender.send(Message::Put(seed)) => {
                result.map_err(|_| MailboxError::Closed)?;
                Ok(())
            },
            _ = &mut stopped => {
                Err(MailboxError::ShuttingDown)
            },
        }
    }

    pub async fn get(&mut self, view: View) -> Result<Seed, MailboxError> {
        let (sender, receiver) = oneshot::channel();
        {
            let mut mailbox_sender = self.sender.clone();
            let mut stopped = self.stopped.clone();
            select! {
                result = mailbox_sender.send(Message::Get { view, response: sender }) => {
                    result.map_err(|_| MailboxError::Closed)?;
                },
                _ = &mut stopped => {
                    return Err(MailboxError::ShuttingDown);
                },
            }
        }

        let mut stopped = self.stopped.clone();
        select! {
            result = receiver => {
                result.map_err(|_| MailboxError::Canceled)
            },
            _ = &mut stopped => {
                Err(MailboxError::ShuttingDown)
            },
        }
    }

    pub async fn uploaded(&mut self, view: View) -> Result<(), MailboxError> {
        let mut sender = self.sender.clone();
        let mut stopped = self.stopped.clone();
        select! {
            result = sender.send(Message::Uploaded { view }) => {
                result.map_err(|_| MailboxError::Closed)?;
                Ok(())
            },
            _ = &mut stopped => {
                Err(MailboxError::ShuttingDown)
            },
        }
    }
}

impl Consumer for Mailbox {
    type Key = U64;
    type Value = Bytes;
    type Failure = ();

    async fn deliver(&mut self, key: Self::Key, value: Self::Value) -> bool {
        let (sender, receiver) = oneshot::channel();
        {
            let mut mailbox_sender = self.sender.clone();
            let mut stopped = self.stopped.clone();
            select! {
                result = mailbox_sender.send(Message::Deliver { view: key.into(), signature: value, response: sender }) => {
                    if result.is_err() {
                        warn!("failed to send deliver");
                        return false;
                    }
                },
                _ = &mut stopped => {
                    return false;
                },
            }
        }

        let mut stopped = self.stopped.clone();
        select! {
            result = receiver => {
                result.unwrap_or(false)
            },
            _ = &mut stopped => {
                false
            },
        }
    }

    async fn failed(&mut self, _: Self::Key, _: Self::Failure) {
        // We don't need to do anything on failure, the resolver will retry.
    }
}

impl Producer for Mailbox {
    type Key = U64;

    async fn produce(&mut self, key: Self::Key) -> oneshot::Receiver<Bytes> {
        let (sender, receiver) = oneshot::channel();
        let view = key.into();
        let mut mailbox_sender = self.sender.clone();
        let mut stopped = self.stopped.clone();
        select! {
            result = mailbox_sender.send(Message::Produce { view, response: sender }) => {
                if result.is_err() {
                    warn!("failed to send produce");
                }
            },
            _ = &mut stopped => {},
        }
        receiver
    }
}

impl Reporter for Mailbox {
    type Activity = Activity;

    async fn report(&mut self, activity: Self::Activity) {
        match activity {
            Activity::Notarization(notarization) => {
                let _ = self.put(notarization.seed()).await;
            }
            Activity::Nullification(nullification) => {
                let _ = self.put(nullification.seed()).await;
            }
            Activity::Finalization(finalization) => {
                let _ = self.put(finalization.seed()).await;
            }
            _ => {}
        }
    }
}
