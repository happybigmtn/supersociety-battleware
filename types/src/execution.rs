use bytes::{Buf, BufMut};
use commonware_codec::{
    varint::UInt, Encode, EncodeSize, Error, FixedSize, RangeCfg, Read, ReadExt, ReadRangeExt,
    Write,
};
use commonware_consensus::threshold_simplex::types::{
    Activity as CActivity, Finalization as CFinalization, Notarization as CNotarization,
    Seed as CSeed, View,
};
use commonware_cryptography::{
    bls12381::primitives::variant::{MinSig, Variant},
    ed25519::{self, Batch, PublicKey},
    sha256::{Digest, Sha256},
    BatchVerifier, Committable, Digestible, Hasher, Signer, Verifier,
};
use commonware_utils::{modulo, union};
use std::{fmt::Debug, hash::Hash};

pub const NAMESPACE: &[u8] = b"_SUPERSOCIETY";
pub const TRANSACTION_SUFFIX: &[u8] = b"_TX";
// Phase 1 scaling: Increased from 100 to 500 for higher throughput
pub const MAX_BLOCK_TRANSACTIONS: usize = 500;

pub type Seed = CSeed<MinSig>;
pub type Notarization = CNotarization<MinSig, Digest>;
pub type Finalization = CFinalization<MinSig, Digest>;
pub type Activity = CActivity<MinSig, Digest>;

pub type Identity = <MinSig as Variant>::Public;
pub type Evaluation = Identity;
pub type Signature = <MinSig as Variant>::Signature;

#[inline]
pub fn transaction_namespace(namespace: &[u8]) -> Vec<u8> {
    union(namespace, TRANSACTION_SUFFIX)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transaction {
    pub nonce: u64,
    pub instruction: Instruction,

    pub public: ed25519::PublicKey,
    pub signature: ed25519::Signature,
}

impl Transaction {
    fn payload(nonce: &u64, instruction: &Instruction) -> Vec<u8> {
        let mut payload = Vec::new();
        nonce.write(&mut payload);
        instruction.write(&mut payload);

        payload
    }

    pub fn sign(private: &ed25519::PrivateKey, nonce: u64, instruction: Instruction) -> Self {
        let signature = private.sign(
            Some(&transaction_namespace(NAMESPACE)),
            &Self::payload(&nonce, &instruction),
        );

        Self {
            nonce,
            instruction,
            public: private.public_key(),
            signature,
        }
    }

    pub fn verify(&self) -> bool {
        self.public.verify(
            Some(&transaction_namespace(NAMESPACE)),
            &Self::payload(&self.nonce, &self.instruction),
            &self.signature,
        )
    }

    pub fn verify_batch(&self, batch: &mut Batch) {
        batch.add(
            Some(&transaction_namespace(NAMESPACE)),
            &Self::payload(&self.nonce, &self.instruction),
            &self.public,
            &self.signature,
        );
    }
}

impl Write for Transaction {
    fn write(&self, writer: &mut impl BufMut) {
        self.nonce.write(writer);
        self.instruction.write(writer);
        self.public.write(writer);
        self.signature.write(writer);
    }
}

impl Read for Transaction {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let nonce = u64::read(reader)?;
        let instruction = Instruction::read(reader)?;
        let public = ed25519::PublicKey::read(reader)?;
        let signature = ed25519::Signature::read(reader)?;

        Ok(Self {
            nonce,
            instruction,
            public,
            signature,
        })
    }
}

impl EncodeSize for Transaction {
    fn encode_size(&self) -> usize {
        self.nonce.encode_size()
            + self.instruction.encode_size()
            + self.public.encode_size()
            + self.signature.encode_size()
    }
}

impl Digestible for Transaction {
    type Digest = Digest;

    fn digest(&self) -> Digest {
        let mut hasher = Sha256::new();
        hasher.update(self.nonce.to_be_bytes().as_ref());
        hasher.update(self.instruction.encode().as_ref());
        hasher.update(self.public.as_ref());
        // We don't include the signature as part of the digest (any valid
        // signature will be valid for the transaction)
        hasher.finalize()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)]
pub enum Instruction {
    // Casino instructions (tags 10-17)
    /// Register a new casino player with a name.
    /// Binary: [10] [nameLen:u32 BE] [nameBytes...]
    CasinoRegister { name: String },

    /// Deposit chips (for testing/faucet).
    /// Binary: [11] [amount:u64 BE]
    CasinoDeposit { amount: u64 },

    /// Start a new casino game session.
    /// Binary: [12] [gameType:u8] [bet:u64 BE] [sessionId:u64 BE]
    CasinoStartGame {
        game_type: crate::casino::GameType,
        bet: u64,
        session_id: u64,
    },

    /// Make a move in an active casino game.
    /// Binary: [13] [sessionId:u64 BE] [payloadLen:u32 BE] [payload...]
    CasinoGameMove { session_id: u64, payload: Vec<u8> },

    /// Toggle shield modifier for next game.
    /// Binary: [14]
    CasinoToggleShield,

    /// Toggle double modifier for next game.
    /// Binary: [15]
    CasinoToggleDouble,

    /// Join a tournament.
    /// Binary: [16] [tournamentId:u64 BE]
    CasinoJoinTournament { tournament_id: u64 },

    /// Start a tournament (transitions from Registration to Active phase).
    /// Also resets all joined players' chips/shields/doubles to starting values.
    /// Binary: [17] [tournamentId:u64 BE] [startTimeMs:u64 BE] [endTimeMs:u64 BE]
    CasinoStartTournament {
        tournament_id: u64,
        start_time_ms: u64,
        end_time_ms: u64,
    },
}

impl Write for Instruction {
    fn write(&self, writer: &mut impl BufMut) {
        match self {
            // Casino instructions (tags 10-17)
            Self::CasinoRegister { name } => {
                10u8.write(writer);
                (name.len() as u32).write(writer);
                writer.put_slice(name.as_bytes());
            }
            Self::CasinoDeposit { amount } => {
                11u8.write(writer);
                amount.write(writer);
            }
            Self::CasinoStartGame { game_type, bet, session_id } => {
                12u8.write(writer);
                game_type.write(writer);
                bet.write(writer);
                session_id.write(writer);
            }
            Self::CasinoGameMove { session_id, payload } => {
                13u8.write(writer);
                session_id.write(writer);
                (payload.len() as u32).write(writer);
                writer.put_slice(payload);
            }
            Self::CasinoToggleShield => 14u8.write(writer),
            Self::CasinoToggleDouble => 15u8.write(writer),
            Self::CasinoJoinTournament { tournament_id } => {
                16u8.write(writer);
                tournament_id.write(writer);
            }
            Self::CasinoStartTournament { tournament_id, start_time_ms, end_time_ms } => {
                17u8.write(writer);
                tournament_id.write(writer);
                start_time_ms.write(writer);
                end_time_ms.write(writer);
            }
        }
    }
}

/// Maximum name length for casino player registration
pub const CASINO_MAX_NAME_LENGTH: usize = 32;

/// Maximum payload length for casino game moves
pub const CASINO_MAX_PAYLOAD_LENGTH: usize = 256;

impl Read for Instruction {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let instruction = match reader.get_u8() {
            // Casino instructions (tags 10-17)
            10 => {
                let name_len = u32::read(reader)? as usize;
                if name_len > CASINO_MAX_NAME_LENGTH {
                    return Err(Error::Invalid("Instruction", "casino name too long"));
                }
                if reader.remaining() < name_len {
                    return Err(Error::EndOfBuffer);
                }
                let mut name_bytes = vec![0u8; name_len];
                reader.copy_to_slice(&mut name_bytes);
                let name = String::from_utf8(name_bytes)
                    .map_err(|_| Error::Invalid("Instruction", "invalid UTF-8 in casino name"))?;
                Self::CasinoRegister { name }
            }
            11 => Self::CasinoDeposit { amount: u64::read(reader)? },
            12 => Self::CasinoStartGame {
                game_type: crate::casino::GameType::read(reader)?,
                bet: u64::read(reader)?,
                session_id: u64::read(reader)?,
            },
            13 => {
                let session_id = u64::read(reader)?;
                let payload_len = u32::read(reader)? as usize;
                if payload_len > CASINO_MAX_PAYLOAD_LENGTH {
                    return Err(Error::Invalid("Instruction", "casino payload too long"));
                }
                if reader.remaining() < payload_len {
                    return Err(Error::EndOfBuffer);
                }
                let mut payload = vec![0u8; payload_len];
                reader.copy_to_slice(&mut payload);
                Self::CasinoGameMove { session_id, payload }
            }
            14 => Self::CasinoToggleShield,
            15 => Self::CasinoToggleDouble,
            16 => Self::CasinoJoinTournament { tournament_id: u64::read(reader)? },
            17 => Self::CasinoStartTournament {
                tournament_id: u64::read(reader)?,
                start_time_ms: u64::read(reader)?,
                end_time_ms: u64::read(reader)?,
            },

            i => return Err(Error::InvalidEnum(i)),
        };

        Ok(instruction)
    }
}

impl EncodeSize for Instruction {
    fn encode_size(&self) -> usize {
        u8::SIZE
            + match self {
                // Casino
                Self::CasinoRegister { name } => 4 + name.len(),
                Self::CasinoDeposit { .. } => 8,
                Self::CasinoStartGame { .. } => 1 + 8 + 8,
                Self::CasinoGameMove { payload, .. } => 8 + 4 + payload.len(),
                Self::CasinoToggleShield | Self::CasinoToggleDouble => 0,
                Self::CasinoJoinTournament { .. } => 8,
                Self::CasinoStartTournament { .. } => 8 + 8 + 8, // tournament_id + start_time_ms + end_time_ms
            }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub parent: Digest,

    pub view: View,
    pub height: u64,

    pub transactions: Vec<Transaction>,

    digest: Digest,
}

impl Block {
    fn compute_digest(
        parent: &Digest,
        view: View,
        height: u64,
        transactions: &[Transaction],
    ) -> Digest {
        let mut hasher = Sha256::new();
        hasher.update(parent);
        hasher.update(&view.to_be_bytes());
        hasher.update(&height.to_be_bytes());
        for transaction in transactions {
            hasher.update(&transaction.digest());
        }
        hasher.finalize()
    }

    pub fn new(parent: Digest, view: View, height: u64, transactions: Vec<Transaction>) -> Self {
        assert!(transactions.len() <= MAX_BLOCK_TRANSACTIONS);
        let digest = Self::compute_digest(&parent, view, height, &transactions);
        Self {
            parent,
            view,
            height,
            transactions,
            digest,
        }
    }
}

impl Write for Block {
    fn write(&self, writer: &mut impl BufMut) {
        self.parent.write(writer);
        UInt(self.view).write(writer);
        UInt(self.height).write(writer);
        self.transactions.write(writer);
    }
}

impl Read for Block {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let parent = Digest::read(reader)?;
        let view = UInt::read(reader)?.into();
        let height = UInt::read(reader)?.into();
        let transactions = Vec::<Transaction>::read_cfg(
            reader,
            &(RangeCfg::from(0..=MAX_BLOCK_TRANSACTIONS), ()),
        )?;

        // Pre-compute the digest
        let digest = Self::compute_digest(&parent, view, height, &transactions);
        Ok(Self {
            parent,
            view,
            height,
            transactions,
            digest,
        })
    }
}

impl EncodeSize for Block {
    fn encode_size(&self) -> usize {
        self.parent.encode_size()
            + UInt(self.view).encode_size()
            + UInt(self.height).encode_size()
            + self.transactions.encode_size()
    }
}

impl Digestible for Block {
    type Digest = Digest;

    fn digest(&self) -> Digest {
        self.digest
    }
}

impl Committable for Block {
    type Commitment = Digest;

    fn commitment(&self) -> Digest {
        self.digest
    }
}

impl commonware_consensus::Block for Block {
    fn parent(&self) -> Digest {
        self.parent
    }

    fn height(&self) -> u64 {
        self.height
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notarized {
    pub proof: CNotarization<MinSig, Digest>,
    pub block: Block,
}

impl Notarized {
    pub fn new(proof: CNotarization<MinSig, Digest>, block: Block) -> Self {
        Self { proof, block }
    }

    pub fn verify(&self, namespace: &[u8], identity: &<MinSig as Variant>::Public) -> bool {
        self.proof.verify(namespace, identity)
    }
}

impl Write for Notarized {
    fn write(&self, buf: &mut impl BufMut) {
        self.proof.write(buf);
        self.block.write(buf);
    }
}

impl Read for Notarized {
    type Cfg = ();

    fn read_cfg(buf: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let proof = CNotarization::<MinSig, Digest>::read(buf)?;
        let block = Block::read(buf)?;

        // Ensure the proof is for the block
        if proof.proposal.payload != block.digest() {
            return Err(Error::Invalid(
                "types::Notarized",
                "Proof payload does not match block digest",
            ));
        }
        Ok(Self { proof, block })
    }
}

impl EncodeSize for Notarized {
    fn encode_size(&self) -> usize {
        self.proof.encode_size() + self.block.encode_size()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finalized {
    pub proof: CFinalization<MinSig, Digest>,
    pub block: Block,
}

impl Finalized {
    pub fn new(proof: CFinalization<MinSig, Digest>, block: Block) -> Self {
        Self { proof, block }
    }

    pub fn verify(&self, namespace: &[u8], identity: &<MinSig as Variant>::Public) -> bool {
        self.proof.verify(namespace, identity)
    }
}

impl Write for Finalized {
    fn write(&self, buf: &mut impl BufMut) {
        self.proof.write(buf);
        self.block.write(buf);
    }
}

impl Read for Finalized {
    type Cfg = ();

    fn read_cfg(buf: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let proof = Finalization::read(buf)?;
        let block = Block::read(buf)?;

        // Ensure the proof is for the block
        if proof.proposal.payload != block.digest() {
            return Err(Error::Invalid(
                "types::Finalized",
                "Proof payload does not match block digest",
            ));
        }
        Ok(Self { proof, block })
    }
}

impl EncodeSize for Finalized {
    fn encode_size(&self) -> usize {
        self.proof.encode_size() + self.block.encode_size()
    }
}

/// The leader for a given seed is determined by the modulo of the seed with the number of participants.
pub fn leader_index(seed: &[u8], participants: usize) -> usize {
    modulo(seed, participants as u64) as usize
}

/// Minimal account structure for transaction nonce tracking.
/// Used for replay protection across all transaction types.
#[derive(Clone, Default, Eq, PartialEq, Debug)]
pub struct Account {
    pub nonce: u64,
}

impl Write for Account {
    fn write(&self, writer: &mut impl BufMut) {
        self.nonce.write(writer);
    }
}

impl Read for Account {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            nonce: u64::read(reader)?,
        })
    }
}

impl EncodeSize for Account {
    fn encode_size(&self) -> usize {
        self.nonce.encode_size()
    }
}

#[derive(Hash, Eq, PartialEq, Ord, PartialOrd, Clone)]
pub enum Key {
    /// Account for nonce tracking (tag 0)
    Account(PublicKey),

    // Casino keys (tags 10-13)
    CasinoPlayer(PublicKey),
    CasinoSession(u64),
    CasinoLeaderboard,
    Tournament(u64),
}

impl Write for Key {
    fn write(&self, writer: &mut impl BufMut) {
        match self {
            // Account key (tag 0)
            Self::Account(pk) => {
                0u8.write(writer);
                pk.write(writer);
            }

            // Casino keys (tags 10-13)
            Self::CasinoPlayer(pk) => {
                10u8.write(writer);
                pk.write(writer);
            }
            Self::CasinoSession(id) => {
                11u8.write(writer);
                id.write(writer);
            }
            Self::CasinoLeaderboard => 12u8.write(writer),
            Self::Tournament(id) => {
                13u8.write(writer);
                id.write(writer);
            }
        }
    }
}

impl Read for Key {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let key = match reader.get_u8() {
            // Account key (tag 0)
            0 => Self::Account(PublicKey::read(reader)?),

            // Casino keys (tags 10-13)
            10 => Self::CasinoPlayer(PublicKey::read(reader)?),
            11 => Self::CasinoSession(u64::read(reader)?),
            12 => Self::CasinoLeaderboard,
            13 => Self::Tournament(u64::read(reader)?),

            i => return Err(Error::InvalidEnum(i)),
        };

        Ok(key)
    }
}

impl EncodeSize for Key {
    fn encode_size(&self) -> usize {
        u8::SIZE
            + match self {
                // Account key
                Self::Account(_) => PublicKey::SIZE,

                // Casino keys
                Self::CasinoPlayer(_) => PublicKey::SIZE,
                Self::CasinoSession(_) => u64::SIZE,
                Self::CasinoLeaderboard => 0,
                Self::Tournament(_) => u64::SIZE,
            }
    }
}

#[derive(Clone, Eq, PartialEq, Debug)]
#[allow(clippy::large_enum_variant)]
pub enum Value {
    /// Account for nonce tracking (tag 0)
    Account(Account),

    // System values
    Commit {
        height: u64,
        start: u64,
    },

    // Casino values (tags 10-13)
    CasinoPlayer(crate::casino::Player),
    CasinoSession(crate::casino::GameSession),
    CasinoLeaderboard(crate::casino::CasinoLeaderboard),
    Tournament(crate::casino::Tournament),
}

impl Write for Value {
    fn write(&self, writer: &mut impl BufMut) {
        match self {
            // Account value (tag 0)
            Self::Account(account) => {
                0u8.write(writer);
                account.write(writer);
            }

            // System values
            Self::Commit { height, start } => {
                3u8.write(writer);
                height.write(writer);
                start.write(writer);
            }

            // Casino values (tags 10-13)
            Self::CasinoPlayer(player) => {
                10u8.write(writer);
                player.write(writer);
            }
            Self::CasinoSession(session) => {
                11u8.write(writer);
                session.write(writer);
            }
            Self::CasinoLeaderboard(leaderboard) => {
                12u8.write(writer);
                leaderboard.write(writer);
            }
            Self::Tournament(tournament) => {
                13u8.write(writer);
                tournament.write(writer);
            }
        }
    }
}

impl Read for Value {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let value = match reader.get_u8() {
            // Account value (tag 0)
            0 => Self::Account(Account::read(reader)?),

            // System values
            3 => Self::Commit {
                height: u64::read(reader)?,
                start: u64::read(reader)?,
            },

            // Casino values (tags 10-13)
            10 => Self::CasinoPlayer(crate::casino::Player::read(reader)?),
            11 => Self::CasinoSession(crate::casino::GameSession::read(reader)?),
            12 => Self::CasinoLeaderboard(crate::casino::CasinoLeaderboard::read(reader)?),
            13 => Self::Tournament(crate::casino::Tournament::read(reader)?),

            i => return Err(Error::InvalidEnum(i)),
        };

        Ok(value)
    }
}

impl EncodeSize for Value {
    fn encode_size(&self) -> usize {
        u8::SIZE
            + match self {
                // Account value
                Self::Account(account) => account.encode_size(),

                // System values
                Self::Commit { height, start } => height.encode_size() + start.encode_size(),

                // Casino values
                Self::CasinoPlayer(player) => player.encode_size(),
                Self::CasinoSession(session) => session.encode_size(),
                Self::CasinoLeaderboard(leaderboard) => leaderboard.encode_size(),
                Self::Tournament(tournament) => tournament.encode_size(),
            }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)]
pub enum Event {
    // Casino events (tags 20-24)
    CasinoPlayerRegistered {
        player: PublicKey,
        name: String,
    },
    CasinoGameStarted {
        session_id: u64,
        player: PublicKey,
        game_type: crate::casino::GameType,
        bet: u64,
        initial_state: Vec<u8>,
    },
    CasinoGameMoved {
        session_id: u64,
        move_number: u32,
        new_state: Vec<u8>,
    },
    CasinoGameCompleted {
        session_id: u64,
        player: PublicKey,
        game_type: crate::casino::GameType,
        payout: i64,
        final_chips: u64,
        was_shielded: bool,
        was_doubled: bool,
    },
    CasinoLeaderboardUpdated {
        leaderboard: crate::casino::CasinoLeaderboard,
    },

    // Error event (tag 29)
    CasinoError {
        player: PublicKey,
        session_id: Option<u64>,
        error_code: u8,
        message: String,
    },

    // Tournament events (tags 25-28)
    TournamentStarted {
        id: u64,
        start_block: u64,
    },
    PlayerJoined {
        tournament_id: u64,
        player: PublicKey,
    },
    TournamentPhaseChanged {
        id: u64,
        phase: crate::casino::TournamentPhase,
    },
    TournamentEnded {
        id: u64,
        rankings: Vec<(PublicKey, u64)>,
    },
}

impl Write for Event {
    fn write(&self, writer: &mut impl BufMut) {
        match self {
            // Casino events (tags 20-24)
            Self::CasinoPlayerRegistered { player, name } => {
                20u8.write(writer);
                player.write(writer);
                (name.len() as u32).write(writer);
                writer.put_slice(name.as_bytes());
            }
            Self::CasinoGameStarted {
                session_id,
                player,
                game_type,
                bet,
                initial_state,
            } => {
                21u8.write(writer);
                session_id.write(writer);
                player.write(writer);
                game_type.write(writer);
                bet.write(writer);
                initial_state.write(writer);
            }
            Self::CasinoGameMoved {
                session_id,
                move_number,
                new_state,
            } => {
                22u8.write(writer);
                session_id.write(writer);
                move_number.write(writer);
                new_state.write(writer);
            }
            Self::CasinoGameCompleted {
                session_id,
                player,
                game_type,
                payout,
                final_chips,
                was_shielded,
                was_doubled,
            } => {
                23u8.write(writer);
                session_id.write(writer);
                player.write(writer);
                game_type.write(writer);
                payout.write(writer);
                final_chips.write(writer);
                was_shielded.write(writer);
                was_doubled.write(writer);
            }
            Self::CasinoLeaderboardUpdated { leaderboard } => {
                24u8.write(writer);
                leaderboard.write(writer);
            }
            Self::CasinoError {
                player,
                session_id,
                error_code,
                message,
            } => {
                29u8.write(writer);
                player.write(writer);
                session_id.write(writer);
                error_code.write(writer);
                (message.len() as u32).write(writer);
                writer.put_slice(message.as_bytes());
            }

            // Tournament events (tags 25-28)
            Self::TournamentStarted { id, start_block } => {
                25u8.write(writer);
                id.write(writer);
                start_block.write(writer);
            }
            Self::PlayerJoined { tournament_id, player } => {
                26u8.write(writer);
                tournament_id.write(writer);
                player.write(writer);
            }
            Self::TournamentPhaseChanged { id, phase } => {
                27u8.write(writer);
                id.write(writer);
                phase.write(writer);
            }
            Self::TournamentEnded { id, rankings } => {
                28u8.write(writer);
                id.write(writer);
                rankings.write(writer);
            }
        }
    }
}

impl Read for Event {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let event = match reader.get_u8() {
            // Casino events (tags 20-24)
            20 => {
                let player = PublicKey::read(reader)?;
                let name_len = u32::read(reader)? as usize;
                if name_len > CASINO_MAX_NAME_LENGTH {
                    return Err(Error::Invalid("Event", "casino name too long"));
                }
                if reader.remaining() < name_len {
                    return Err(Error::EndOfBuffer);
                }
                let mut name_bytes = vec![0u8; name_len];
                reader.copy_to_slice(&mut name_bytes);
                let name = String::from_utf8(name_bytes)
                    .map_err(|_| Error::Invalid("Event", "invalid UTF-8 in casino name"))?;
                Self::CasinoPlayerRegistered { player, name }
            }
            21 => Self::CasinoGameStarted {
                session_id: u64::read(reader)?,
                player: PublicKey::read(reader)?,
                game_type: crate::casino::GameType::read(reader)?,
                bet: u64::read(reader)?,
                initial_state: Vec::<u8>::read_range(reader, 0..=1024)?,
            },
            22 => Self::CasinoGameMoved {
                session_id: u64::read(reader)?,
                move_number: u32::read(reader)?,
                new_state: Vec::<u8>::read_range(reader, 0..=1024)?,
            },
            23 => Self::CasinoGameCompleted {
                session_id: u64::read(reader)?,
                player: PublicKey::read(reader)?,
                game_type: crate::casino::GameType::read(reader)?,
                payout: i64::read(reader)?,
                final_chips: u64::read(reader)?,
                was_shielded: bool::read(reader)?,
                was_doubled: bool::read(reader)?,
            },
            24 => Self::CasinoLeaderboardUpdated {
                leaderboard: crate::casino::CasinoLeaderboard::read(reader)?,
            },
            29 => {
                let player = PublicKey::read(reader)?;
                let session_id = Option::<u64>::read(reader)?;
                let error_code = u8::read(reader)?;
                let message_len = u32::read(reader)? as usize;
                const MAX_ERROR_MESSAGE_LENGTH: usize = 256;
                if message_len > MAX_ERROR_MESSAGE_LENGTH {
                    return Err(Error::Invalid("Event", "error message too long"));
                }
                if reader.remaining() < message_len {
                    return Err(Error::EndOfBuffer);
                }
                let mut message_bytes = vec![0u8; message_len];
                reader.copy_to_slice(&mut message_bytes);
                let message = String::from_utf8(message_bytes)
                    .map_err(|_| Error::Invalid("Event", "invalid UTF-8 in error message"))?;
                Self::CasinoError {
                    player,
                    session_id,
                    error_code,
                    message,
                }
            }

            // Tournament events (tags 25-28)
            25 => Self::TournamentStarted {
                id: u64::read(reader)?,
                start_block: u64::read(reader)?,
            },
            26 => Self::PlayerJoined {
                tournament_id: u64::read(reader)?,
                player: PublicKey::read(reader)?,
            },
            27 => Self::TournamentPhaseChanged {
                id: u64::read(reader)?,
                phase: crate::casino::TournamentPhase::read(reader)?,
            },
            28 => Self::TournamentEnded {
                id: u64::read(reader)?,
                rankings: Vec::<(PublicKey, u64)>::read_range(reader, 0..=1000)?,
            },

            i => return Err(Error::InvalidEnum(i)),
        };

        Ok(event)
    }
}

impl EncodeSize for Event {
    fn encode_size(&self) -> usize {
        u8::SIZE
            + match self {
                // Casino events (tags 20-24)
                Self::CasinoPlayerRegistered { player, name } => {
                    player.encode_size() + 4 + name.len()
                }
                Self::CasinoGameStarted {
                    session_id,
                    player,
                    game_type,
                    bet,
                    initial_state,
                } => {
                    session_id.encode_size()
                        + player.encode_size()
                        + game_type.encode_size()
                        + bet.encode_size()
                        + initial_state.encode_size()
                }
                Self::CasinoGameMoved {
                    session_id,
                    move_number,
                    new_state,
                } => {
                    session_id.encode_size() + move_number.encode_size() + new_state.encode_size()
                }
                Self::CasinoGameCompleted {
                    session_id,
                    player,
                    game_type,
                    payout,
                    final_chips,
                    was_shielded,
                    was_doubled,
                } => {
                    session_id.encode_size()
                        + player.encode_size()
                        + game_type.encode_size()
                        + payout.encode_size()
                        + final_chips.encode_size()
                        + was_shielded.encode_size()
                        + was_doubled.encode_size()
                }
                Self::CasinoLeaderboardUpdated { leaderboard } => leaderboard.encode_size(),
                Self::CasinoError {
                    player,
                    session_id,
                    error_code,
                    message,
                } => {
                    player.encode_size()
                        + session_id.encode_size()
                        + error_code.encode_size()
                        + 4
                        + message.len()
                }

                // Tournament events (tags 25-28)
                Self::TournamentStarted { id, start_block } => {
                    id.encode_size() + start_block.encode_size()
                }
                Self::PlayerJoined { tournament_id, player } => {
                    tournament_id.encode_size() + player.encode_size()
                }
                Self::TournamentPhaseChanged { id, phase } => {
                    id.encode_size() + phase.encode_size()
                }
                Self::TournamentEnded { id, rankings } => {
                    id.encode_size() + rankings.encode_size()
                }
            }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Output {
    Event(Event),
    Transaction(Transaction),
    Commit { height: u64, start: u64 },
}

impl Write for Output {
    fn write(&self, writer: &mut impl BufMut) {
        match self {
            Self::Event(event) => {
                0u8.write(writer);
                event.write(writer);
            }
            Self::Transaction(transaction) => {
                1u8.write(writer);
                transaction.write(writer);
            }
            Self::Commit { height, start } => {
                2u8.write(writer);
                height.write(writer);
                start.write(writer);
            }
        }
    }
}

impl Read for Output {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let kind = u8::read(reader)?;
        match kind {
            0 => Ok(Self::Event(Event::read(reader)?)),
            1 => Ok(Self::Transaction(Transaction::read(reader)?)),
            2 => Ok(Self::Commit {
                height: u64::read(reader)?,
                start: u64::read(reader)?,
            }),
            _ => Err(Error::InvalidEnum(kind)),
        }
    }
}

impl EncodeSize for Output {
    fn encode_size(&self) -> usize {
        1 + match self {
            Self::Event(event) => event.encode_size(),
            Self::Transaction(transaction) => transaction.encode_size(),
            Self::Commit { height, start } => height.encode_size() + start.encode_size(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub view: View,
    pub height: u64,
    pub block_digest: Digest,
    pub state_root: Digest,
    pub state_start_op: u64,
    pub state_end_op: u64,
    pub events_root: Digest,
    pub events_start_op: u64,
    pub events_end_op: u64,
}

impl Progress {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        view: View,
        height: u64,
        block_digest: Digest,
        state_root: Digest,
        state_start_op: u64,
        state_end_op: u64,
        events_root: Digest,
        events_start_op: u64,
        events_end_op: u64,
    ) -> Self {
        Self {
            view,
            height,
            block_digest,
            state_root,
            state_start_op,
            state_end_op,
            events_root,
            events_start_op,
            events_end_op,
        }
    }
}

impl Write for Progress {
    fn write(&self, writer: &mut impl BufMut) {
        self.view.write(writer);
        self.height.write(writer);
        self.block_digest.write(writer);
        self.state_root.write(writer);
        self.state_start_op.write(writer);
        self.state_end_op.write(writer);
        self.events_root.write(writer);
        self.events_start_op.write(writer);
        self.events_end_op.write(writer);
    }
}

impl Read for Progress {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            view: View::read(reader)?,
            height: u64::read(reader)?,
            block_digest: Digest::read(reader)?,
            state_root: Digest::read(reader)?,
            state_start_op: u64::read(reader)?,
            state_end_op: u64::read(reader)?,
            events_root: Digest::read(reader)?,
            events_start_op: u64::read(reader)?,
            events_end_op: u64::read(reader)?,
        })
    }
}

impl FixedSize for Progress {
    const SIZE: usize = View::SIZE
        + u64::SIZE
        + Digest::SIZE
        + Digest::SIZE
        + u64::SIZE
        + u64::SIZE
        + Digest::SIZE
        + u64::SIZE
        + u64::SIZE;
}

impl Digestible for Progress {
    type Digest = Digest;

    fn digest(&self) -> Digest {
        Sha256::hash(&self.encode())
    }
}

