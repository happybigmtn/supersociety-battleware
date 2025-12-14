use bytes::{Buf, BufMut};
use commonware_codec::{EncodeSize, Error, FixedSize, Read, ReadExt, ReadRangeExt, Write};

/// Casino game types matching frontend GameType enum
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum GameType {
    Baccarat = 0,
    Blackjack = 1,
    CasinoWar = 2,
    Craps = 3,
    VideoPoker = 4,
    HiLo = 5,
    Roulette = 6,
    SicBo = 7,
    ThreeCard = 8,
    UltimateHoldem = 9,
}

impl Write for GameType {
    fn write(&self, writer: &mut impl BufMut) {
        (*self as u8).write(writer);
    }
}

impl Read for GameType {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let value = u8::read(reader)?;
        match value {
            0 => Ok(Self::Baccarat),
            1 => Ok(Self::Blackjack),
            2 => Ok(Self::CasinoWar),
            3 => Ok(Self::Craps),
            4 => Ok(Self::VideoPoker),
            5 => Ok(Self::HiLo),
            6 => Ok(Self::Roulette),
            7 => Ok(Self::SicBo),
            8 => Ok(Self::ThreeCard),
            9 => Ok(Self::UltimateHoldem),
            i => Err(Error::InvalidEnum(i)),
        }
    }
}

impl FixedSize for GameType {
    const SIZE: usize = 1;
}

/// Super mode multiplier type
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SuperType {
    Card = 0,   // Specific card (rank+suit)
    Number = 1, // Roulette/Craps number
    Total = 2,  // Sic Bo sum
    Rank = 3,   // Card rank only
    Suit = 4,   // Card suit only
}

impl Write for SuperType {
    fn write(&self, writer: &mut impl BufMut) {
        (*self as u8).write(writer);
    }
}

impl Read for SuperType {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let value = u8::read(reader)?;
        match value {
            0 => Ok(Self::Card),
            1 => Ok(Self::Number),
            2 => Ok(Self::Total),
            3 => Ok(Self::Rank),
            4 => Ok(Self::Suit),
            i => Err(Error::InvalidEnum(i)),
        }
    }
}

impl FixedSize for SuperType {
    const SIZE: usize = 1;
}

/// Super mode multiplier entry
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuperMultiplier {
    pub id: u8,          // Card (0-51), number (0-36), or total (4-17)
    pub multiplier: u16, // 2-500x
    pub super_type: SuperType,
}

impl Write for SuperMultiplier {
    fn write(&self, writer: &mut impl BufMut) {
        self.id.write(writer);
        self.multiplier.write(writer);
        self.super_type.write(writer);
    }
}

impl Read for SuperMultiplier {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            id: u8::read(reader)?,
            multiplier: u16::read(reader)?,
            super_type: SuperType::read(reader)?,
        })
    }
}

impl EncodeSize for SuperMultiplier {
    fn encode_size(&self) -> usize {
        self.id.encode_size() + self.multiplier.encode_size() + self.super_type.encode_size()
    }
}

/// Super mode state
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SuperModeState {
    pub is_active: bool,
    pub multipliers: Vec<SuperMultiplier>,
    pub streak_level: u8, // For HiLo only
}

impl Write for SuperModeState {
    fn write(&self, writer: &mut impl BufMut) {
        self.is_active.write(writer);
        self.multipliers.write(writer);
        self.streak_level.write(writer);
    }
}

impl Read for SuperModeState {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            is_active: bool::read(reader)?,
            multipliers: Vec::<SuperMultiplier>::read_range(reader, 0..=10)?,
            streak_level: u8::read(reader)?,
        })
    }
}

impl EncodeSize for SuperModeState {
    fn encode_size(&self) -> usize {
        self.is_active.encode_size()
            + self.multipliers.encode_size()
            + self.streak_level.encode_size()
    }
}
