use bytes::{Buf, BufMut};
use commonware_codec::{EncodeSize, Error, FixedSize, Read, ReadExt, ReadRangeExt, Write};
use commonware_cryptography::ed25519::PublicKey;

use super::CasinoLeaderboard;

/// Tournament phases
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum TournamentPhase {
    #[default]
    Registration = 0, // 1 minute (~20 blocks at 3s/block)
    Active = 1, // 5 minutes (~100 blocks)
    Complete = 2,
}

impl Write for TournamentPhase {
    fn write(&self, writer: &mut impl BufMut) {
        (*self as u8).write(writer);
    }
}

impl Read for TournamentPhase {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        match u8::read(reader)? {
            0 => Ok(Self::Registration),
            1 => Ok(Self::Active),
            2 => Ok(Self::Complete),
            i => Err(Error::InvalidEnum(i)),
        }
    }
}

impl FixedSize for TournamentPhase {
    const SIZE: usize = 1;
}

/// Tournament state
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Tournament {
    pub id: u64,
    pub phase: TournamentPhase,
    pub start_block: u64,
    /// Unix timestamp (milliseconds) when the tournament started
    pub start_time_ms: u64,
    /// Unix timestamp (milliseconds) when the tournament ends
    pub end_time_ms: u64,
    pub players: Vec<PublicKey>,
    pub prize_pool: u64,
    pub starting_chips: u64,   // 1000
    pub starting_shields: u32, // 3
    pub starting_doubles: u32, // 3
    pub leaderboard: CasinoLeaderboard,
}

impl Write for Tournament {
    fn write(&self, writer: &mut impl BufMut) {
        self.id.write(writer);
        self.phase.write(writer);
        self.start_block.write(writer);
        self.start_time_ms.write(writer);
        self.end_time_ms.write(writer);
        self.players.write(writer);
        self.prize_pool.write(writer);
        self.starting_chips.write(writer);
        self.starting_shields.write(writer);
        self.starting_doubles.write(writer);
        self.leaderboard.write(writer);
    }
}

impl Read for Tournament {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            id: u64::read(reader)?,
            phase: TournamentPhase::read(reader)?,
            start_block: u64::read(reader)?,
            start_time_ms: u64::read(reader)?,
            end_time_ms: u64::read(reader)?,
            players: Vec::<PublicKey>::read_range(reader, 0..=1000)?,
            prize_pool: u64::read(reader)?,
            starting_chips: u64::read(reader)?,
            starting_shields: u32::read(reader)?,
            starting_doubles: u32::read(reader)?,
            leaderboard: CasinoLeaderboard::read(reader)?,
        })
    }
}

impl EncodeSize for Tournament {
    fn encode_size(&self) -> usize {
        self.id.encode_size()
            + self.phase.encode_size()
            + self.start_block.encode_size()
            + self.start_time_ms.encode_size()
            + self.end_time_ms.encode_size()
            + self.players.encode_size()
            + self.prize_pool.encode_size()
            + self.starting_chips.encode_size()
            + self.starting_shields.encode_size()
            + self.starting_doubles.encode_size()
            + self.leaderboard.encode_size()
    }
}

impl Tournament {
    /// Check if a player is already in the tournament.
    /// Currently O(n), prepared for future HashSet optimization.
    pub fn contains_player(&self, player: &PublicKey) -> bool {
        self.players.contains(player)
    }

    /// Add a player to the tournament.
    /// Returns true if the player was added, false if they were already present.
    pub fn add_player(&mut self, player: PublicKey) -> bool {
        if self.contains_player(&player) {
            return false;
        }
        self.players.push(player);
        true
    }
}
