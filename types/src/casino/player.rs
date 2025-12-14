use bytes::{Buf, BufMut};
use commonware_codec::{EncodeSize, Error, Read, ReadExt, ReadRangeExt, Write};
use commonware_cryptography::ed25519::PublicKey;

use super::{
    read_string, string_encode_size, write_string, GameType, SuperModeState, INITIAL_CHIPS,
    MAX_NAME_LENGTH, STARTING_DOUBLES, STARTING_SHIELDS,
};

/// Player state for casino games
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Player {
    pub nonce: u64,
    pub name: String,
    pub chips: u64,
    pub vusdt_balance: u64, // Virtual USDT balance
    pub shields: u32,
    pub doubles: u32,
    pub tournament_chips: u64,
    pub tournament_shields: u32,
    pub tournament_doubles: u32,
    pub active_tournament: Option<u64>,
    pub rank: u32,
    pub active_shield: bool,
    pub active_double: bool,
    pub active_super: bool,
    pub active_session: Option<u64>,
    pub last_deposit_block: u64,
    /// Aura Meter for Super Mode (0-5 segments).
    /// Increments on near-misses, triggers Super Aura Round at 5.
    pub aura_meter: u8,
    // Tournament tracking
    pub tournaments_played_today: u8,
    pub last_tournament_ts: u64,
    pub is_kyc_verified: bool,
}

impl Player {
    pub fn new(name: String) -> Self {
        Self {
            nonce: 0,
            name,
            chips: INITIAL_CHIPS,
            vusdt_balance: 0,
            shields: STARTING_SHIELDS,
            doubles: STARTING_DOUBLES,
            tournament_chips: 0,
            tournament_shields: 0,
            tournament_doubles: 0,
            active_tournament: None,
            rank: 0,
            active_shield: false,
            active_double: false,
            active_super: false,
            active_session: None,
            // Allow an immediate first faucet deposit
            last_deposit_block: 0,
            aura_meter: 0,
            tournaments_played_today: 0,
            last_tournament_ts: 0,
            is_kyc_verified: false,
        }
    }

    pub fn new_with_block(name: String, _block: u64) -> Self {
        Self {
            nonce: 0,
            name,
            chips: INITIAL_CHIPS,
            vusdt_balance: 0,
            shields: STARTING_SHIELDS,
            doubles: STARTING_DOUBLES,
            tournament_chips: 0,
            tournament_shields: 0,
            tournament_doubles: 0,
            active_tournament: None,
            rank: 0,
            active_shield: false,
            active_double: false,
            active_super: false,
            active_session: None,
            // Allow an immediate first faucet claim (daily limit is enforced by the executor).
            last_deposit_block: 0,
            aura_meter: 0,
            tournaments_played_today: 0,
            last_tournament_ts: 0,
            is_kyc_verified: false,
        }
    }
}

impl Write for Player {
    fn write(&self, writer: &mut impl BufMut) {
        self.nonce.write(writer);
        write_string(&self.name, writer);
        self.chips.write(writer);
        self.vusdt_balance.write(writer);
        self.shields.write(writer);
        self.doubles.write(writer);
        self.tournament_chips.write(writer);
        self.tournament_shields.write(writer);
        self.tournament_doubles.write(writer);
        self.active_tournament.write(writer);
        self.rank.write(writer);
        self.active_shield.write(writer);
        self.active_double.write(writer);
        self.active_super.write(writer);
        self.active_session.write(writer);
        self.last_deposit_block.write(writer);
        self.aura_meter.write(writer);
        self.tournaments_played_today.write(writer);
        self.last_tournament_ts.write(writer);
        self.is_kyc_verified.write(writer);
    }
}

impl Read for Player {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            nonce: u64::read(reader)?,
            name: read_string(reader, MAX_NAME_LENGTH)?,
            chips: u64::read(reader)?,
            vusdt_balance: u64::read(reader)?,
            shields: u32::read(reader)?,
            doubles: u32::read(reader)?,
            tournament_chips: u64::read(reader)?,
            tournament_shields: u32::read(reader)?,
            tournament_doubles: u32::read(reader)?,
            active_tournament: Option::<u64>::read(reader)?,
            rank: u32::read(reader)?,
            active_shield: bool::read(reader)?,
            active_double: bool::read(reader)?,
            active_super: bool::read(reader)?,
            active_session: Option::<u64>::read(reader)?,
            last_deposit_block: u64::read(reader)?,
            aura_meter: u8::read(reader)?,
            tournaments_played_today: u8::read(reader)?,
            last_tournament_ts: u64::read(reader)?,
            is_kyc_verified: bool::read(reader)?,
        })
    }
}

impl EncodeSize for Player {
    fn encode_size(&self) -> usize {
        self.nonce.encode_size()
            + string_encode_size(&self.name)
            + self.chips.encode_size()
            + self.vusdt_balance.encode_size()
            + self.shields.encode_size()
            + self.doubles.encode_size()
            + self.tournament_chips.encode_size()
            + self.tournament_shields.encode_size()
            + self.tournament_doubles.encode_size()
            + self.active_tournament.encode_size()
            + self.rank.encode_size()
            + self.active_shield.encode_size()
            + self.active_double.encode_size()
            + self.active_super.encode_size()
            + self.active_session.encode_size()
            + self.last_deposit_block.encode_size()
            + self.aura_meter.encode_size()
            + self.tournaments_played_today.encode_size()
            + self.last_tournament_ts.encode_size()
            + self.is_kyc_verified.encode_size()
    }
}

/// Game session state
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GameSession {
    pub id: u64,
    pub player: PublicKey,
    pub game_type: GameType,
    pub bet: u64,
    pub state_blob: Vec<u8>,
    pub move_count: u32,
    pub created_at: u64,
    pub is_complete: bool,
    pub super_mode: SuperModeState,
    pub is_tournament: bool,
    pub tournament_id: Option<u64>,
}

impl Write for GameSession {
    fn write(&self, writer: &mut impl BufMut) {
        self.id.write(writer);
        self.player.write(writer);
        self.game_type.write(writer);
        self.bet.write(writer);
        self.state_blob.write(writer);
        self.move_count.write(writer);
        self.created_at.write(writer);
        self.is_complete.write(writer);
        self.super_mode.write(writer);
        self.is_tournament.write(writer);
        self.tournament_id.write(writer);
    }
}

impl Read for GameSession {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            id: u64::read(reader)?,
            player: PublicKey::read(reader)?,
            game_type: GameType::read(reader)?,
            bet: u64::read(reader)?,
            state_blob: Vec::<u8>::read_range(reader, 0..=1024)?,
            move_count: u32::read(reader)?,
            created_at: u64::read(reader)?,
            is_complete: bool::read(reader)?,
            super_mode: SuperModeState::read(reader)?,
            is_tournament: bool::read(reader)?,
            tournament_id: Option::<u64>::read(reader)?,
        })
    }
}

impl EncodeSize for GameSession {
    fn encode_size(&self) -> usize {
        self.id.encode_size()
            + self.player.encode_size()
            + self.game_type.encode_size()
            + self.bet.encode_size()
            + self.state_blob.encode_size()
            + self.move_count.encode_size()
            + self.created_at.encode_size()
            + self.is_complete.encode_size()
            + self.super_mode.encode_size()
            + self.is_tournament.encode_size()
            + self.tournament_id.encode_size()
    }
}
