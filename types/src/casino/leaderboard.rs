use bytes::{Buf, BufMut};
use commonware_codec::{EncodeSize, Error, Read, ReadExt, ReadRangeExt, Write};
use commonware_cryptography::ed25519::PublicKey;

use super::{read_string, string_encode_size, write_string, MAX_NAME_LENGTH};

/// Casino leaderboard entry
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaderboardEntry {
    pub player: PublicKey,
    pub name: String,
    pub chips: u64,
    pub rank: u32,
}

impl Write for LeaderboardEntry {
    fn write(&self, writer: &mut impl BufMut) {
        self.player.write(writer);
        write_string(&self.name, writer);
        self.chips.write(writer);
        self.rank.write(writer);
    }
}

impl Read for LeaderboardEntry {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            player: PublicKey::read(reader)?,
            name: read_string(reader, MAX_NAME_LENGTH)?,
            chips: u64::read(reader)?,
            rank: u32::read(reader)?,
        })
    }
}

impl EncodeSize for LeaderboardEntry {
    fn encode_size(&self) -> usize {
        self.player.encode_size()
            + string_encode_size(&self.name)
            + self.chips.encode_size()
            + self.rank.encode_size()
    }
}

/// Casino leaderboard
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct CasinoLeaderboard {
    pub entries: Vec<LeaderboardEntry>,
}

impl CasinoLeaderboard {
    pub fn update(&mut self, player: PublicKey, name: String, chips: u64) {
        // Find and remove existing entry for this player
        if let Some(idx) = self.entries.iter().position(|e| e.player == player) {
            self.entries.remove(idx);
        }

        // Early exit: if we have 10 entries and new chips is <= lowest, skip
        if self.entries.len() >= 10 {
            if let Some(last) = self.entries.last() {
                if chips <= last.chips {
                    return;
                }
            }
        }

        // Find insertion point using binary search (entries sorted descending by chips)
        // FIXED: Use chips.cmp(&e.chips) for descending order (higher chips first)
        // This reverses the comparison so higher values come before lower values
        let insert_pos = self
            .entries
            .binary_search_by(|e| chips.cmp(&e.chips))
            .unwrap_or_else(|pos| pos);

        // Insert at correct position
        self.entries.insert(
            insert_pos,
            LeaderboardEntry {
                player,
                name,
                chips,
                rank: 0,
            },
        );

        // Truncate to 10 and update ranks only for affected entries
        self.entries.truncate(10);
        for (i, entry) in self.entries.iter_mut().enumerate() {
            entry.rank = (i + 1) as u32;
        }
    }
}

impl Write for CasinoLeaderboard {
    fn write(&self, writer: &mut impl BufMut) {
        self.entries.write(writer);
    }
}

impl Read for CasinoLeaderboard {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            // Read up to 10 entries (matches truncate(10) in update())
            // FIXED: Use inclusive range 0..=10 to allow exactly 10 entries
            entries: Vec::<LeaderboardEntry>::read_range(reader, 0..=10)?,
        })
    }
}

impl EncodeSize for CasinoLeaderboard {
    fn encode_size(&self) -> usize {
        self.entries.encode_size()
    }
}
