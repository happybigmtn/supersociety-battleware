use bytes::{Buf, BufMut};
use commonware_codec::{EncodeSize, Error, FixedSize, Read, ReadExt, Write};

use super::{THREE_CARD_PROGRESSIVE_BASE_JACKPOT, UTH_PROGRESSIVE_BASE_JACKPOT};

/// House state for the "Central Bank" model
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HouseState {
    pub current_epoch: u64,
    pub epoch_start_ts: u64,
    pub net_pnl: i128, // Net Profit/Loss for current epoch (House Edge - Player Wins)
    pub total_staked_amount: u64,
    pub total_voting_power: u128,
    pub accumulated_fees: u64, // Fees from AMM or other sources
    pub total_burned: u64,     // Total RNG burned via Sell Tax
    pub total_issuance: u64,   // Total RNG minted (Inflation)
    pub three_card_progressive_jackpot: u64,
    pub uth_progressive_jackpot: u64,
}

impl HouseState {
    pub fn new(start_ts: u64) -> Self {
        Self {
            current_epoch: 0,
            epoch_start_ts: start_ts,
            net_pnl: 0,
            total_staked_amount: 0,
            total_voting_power: 0,
            accumulated_fees: 0,
            total_burned: 0,
            total_issuance: 0,
            three_card_progressive_jackpot: THREE_CARD_PROGRESSIVE_BASE_JACKPOT,
            uth_progressive_jackpot: UTH_PROGRESSIVE_BASE_JACKPOT,
        }
    }
}

impl Write for HouseState {
    fn write(&self, writer: &mut impl BufMut) {
        self.current_epoch.write(writer);
        self.epoch_start_ts.write(writer);
        self.net_pnl.write(writer);
        self.total_staked_amount.write(writer);
        self.total_voting_power.write(writer);
        self.accumulated_fees.write(writer);
        self.total_burned.write(writer);
        self.total_issuance.write(writer);
        self.three_card_progressive_jackpot.write(writer);
        self.uth_progressive_jackpot.write(writer);
    }
}

impl Read for HouseState {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        let current_epoch = u64::read(reader)?;
        let epoch_start_ts = u64::read(reader)?;
        let net_pnl = i128::read(reader)?;
        let total_staked_amount = u64::read(reader)?;
        let total_voting_power = u128::read(reader)?;
        let accumulated_fees = u64::read(reader)?;
        let total_burned = u64::read(reader)?;
        let total_issuance = u64::read(reader)?;

        // Optional extensions (backwards compatible with older stored HouseState values).
        let three_card_progressive_jackpot = if reader.remaining() >= u64::SIZE {
            u64::read(reader)?
        } else {
            THREE_CARD_PROGRESSIVE_BASE_JACKPOT
        };
        let uth_progressive_jackpot = if reader.remaining() >= u64::SIZE {
            u64::read(reader)?
        } else {
            UTH_PROGRESSIVE_BASE_JACKPOT
        };

        Ok(Self {
            current_epoch,
            epoch_start_ts,
            net_pnl,
            total_staked_amount,
            total_voting_power,
            accumulated_fees,
            total_burned,
            total_issuance,
            three_card_progressive_jackpot,
            uth_progressive_jackpot,
        })
    }
}

impl EncodeSize for HouseState {
    fn encode_size(&self) -> usize {
        self.current_epoch.encode_size()
            + self.epoch_start_ts.encode_size()
            + self.net_pnl.encode_size()
            + self.total_staked_amount.encode_size()
            + self.total_voting_power.encode_size()
            + self.accumulated_fees.encode_size()
            + self.total_burned.encode_size()
            + self.total_issuance.encode_size()
            + self.three_card_progressive_jackpot.encode_size()
            + self.uth_progressive_jackpot.encode_size()
    }
}

/// Staker state
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Staker {
    pub balance: u64,
    pub unlock_ts: u64,
    pub last_claim_epoch: u64,
    pub voting_power: u128,
}

impl Write for Staker {
    fn write(&self, writer: &mut impl BufMut) {
        self.balance.write(writer);
        self.unlock_ts.write(writer);
        self.last_claim_epoch.write(writer);
        self.voting_power.write(writer);
    }
}

impl Read for Staker {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            balance: u64::read(reader)?,
            unlock_ts: u64::read(reader)?,
            last_claim_epoch: u64::read(reader)?,
            voting_power: u128::read(reader)?,
        })
    }
}

impl EncodeSize for Staker {
    fn encode_size(&self) -> usize {
        self.balance.encode_size()
            + self.unlock_ts.encode_size()
            + self.last_claim_epoch.encode_size()
            + self.voting_power.encode_size()
    }
}

/// Vault state for CDP (Collateralized Debt Position)
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Vault {
    pub collateral_rng: u64,
    pub debt_vusdt: u64,
}

impl Write for Vault {
    fn write(&self, writer: &mut impl BufMut) {
        self.collateral_rng.write(writer);
        self.debt_vusdt.write(writer);
    }
}

impl Read for Vault {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            collateral_rng: u64::read(reader)?,
            debt_vusdt: u64::read(reader)?,
        })
    }
}

impl EncodeSize for Vault {
    fn encode_size(&self) -> usize {
        self.collateral_rng.encode_size() + self.debt_vusdt.encode_size()
    }
}

/// AMM Pool state (Constant Product Market Maker)
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct AmmPool {
    pub reserve_rng: u64,
    pub reserve_vusdt: u64,
    pub total_shares: u64,
    pub fee_basis_points: u16,      // e.g., 30 = 0.3%
    pub sell_tax_basis_points: u16, // e.g., 500 = 5%
}

impl AmmPool {
    pub fn new(fee_bps: u16) -> Self {
        Self {
            reserve_rng: 0,
            reserve_vusdt: 0,
            total_shares: 0,
            fee_basis_points: fee_bps,
            sell_tax_basis_points: 500, // 5% default
        }
    }
}

impl Write for AmmPool {
    fn write(&self, writer: &mut impl BufMut) {
        self.reserve_rng.write(writer);
        self.reserve_vusdt.write(writer);
        self.total_shares.write(writer);
        self.fee_basis_points.write(writer);
        self.sell_tax_basis_points.write(writer);
    }
}

impl Read for AmmPool {
    type Cfg = ();

    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, Error> {
        Ok(Self {
            reserve_rng: u64::read(reader)?,
            reserve_vusdt: u64::read(reader)?,
            total_shares: u64::read(reader)?,
            fee_basis_points: u16::read(reader)?,
            sell_tax_basis_points: u16::read(reader)?,
        })
    }
}

impl EncodeSize for AmmPool {
    fn encode_size(&self) -> usize {
        self.reserve_rng.encode_size()
            + self.reserve_vusdt.encode_size()
            + self.total_shares.encode_size()
            + self.fee_basis_points.encode_size()
            + self.sell_tax_basis_points.encode_size()
    }
}
