use bytes::{Buf, BufMut};
use commonware_codec::{EncodeSize, FixedSize, Read, ReadExt, Write};
use commonware_cryptography::ed25519::PublicKey;
use commonware_utils::{from_hex, hex};
use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    ser::SerializeStruct,
    Deserialize, Deserializer, Serialize, Serializer,
};
use std::fmt;

/// Commonware Token Interface (CTI-20)
/// A standard for fungible assets on the Commonware chain.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenMetadata {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub icon_url: Option<String>,
    pub total_supply: u64,
    pub mintable: bool,
    pub burnable: bool,
    pub authority: PublicKey,
}

// Helper to encode hex
fn hex_encode(bytes: &[u8]) -> String {
    hex(bytes)
}

// Helper to decode hex
fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    from_hex(s).ok_or_else(|| "invalid hex string".to_string())
}

impl Default for TokenMetadata {
    fn default() -> Self {
        // Use a known valid Ed25519 public key (from RFC 8032 test vector)
        // d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a
        let bytes = [
            0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64,
            0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68,
            0xf7, 0x07, 0x51, 0x1a,
        ];

        let mut reader = &bytes[..];
        let authority = PublicKey::read(&mut reader).expect("valid public key");

        Self {
            name: "Unknown".to_string(),
            symbol: "UNK".to_string(),
            decimals: 9,
            icon_url: None,
            total_supply: 0,
            mintable: false,
            burnable: false,
            authority,
        }
    }
}

// Manual Serialize/Deserialize for TokenMetadata
impl Serialize for TokenMetadata {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("TokenMetadata", 8)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("symbol", &self.symbol)?;
        state.serialize_field("decimals", &self.decimals)?;
        state.serialize_field("icon_url", &self.icon_url)?;
        state.serialize_field("total_supply", &self.total_supply)?;
        state.serialize_field("mintable", &self.mintable)?;
        state.serialize_field("burnable", &self.burnable)?;
        state.serialize_field("authority", &hex_encode(self.authority.as_ref()))?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for TokenMetadata {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        enum Field {
            Name,
            Symbol,
            Decimals,
            IconUrl,
            TotalSupply,
            Mintable,
            Burnable,
            Authority,
        }

        impl<'de> Deserialize<'de> for Field {
            fn deserialize<D>(deserializer: D) -> Result<Field, D::Error>
            where
                D: Deserializer<'de>,
            {
                struct FieldVisitor;
                impl<'de> Visitor<'de> for FieldVisitor {
                    type Value = Field;
                    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                        formatter.write_str("field identifier")
                    }
                    fn visit_str<E>(self, value: &str) -> Result<Field, E>
                    where
                        E: de::Error,
                    {
                        match value {
                            "name" => Ok(Field::Name),
                            "symbol" => Ok(Field::Symbol),
                            "decimals" => Ok(Field::Decimals),
                            "icon_url" => Ok(Field::IconUrl),
                            "total_supply" => Ok(Field::TotalSupply),
                            "mintable" => Ok(Field::Mintable),
                            "burnable" => Ok(Field::Burnable),
                            "authority" => Ok(Field::Authority),
                            _ => Err(de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(FieldVisitor)
            }
        }

        struct TokenMetadataVisitor;
        const FIELDS: &[&str] = &[
            "name",
            "symbol",
            "decimals",
            "icon_url",
            "total_supply",
            "mintable",
            "burnable",
            "authority",
        ];

        impl<'de> Visitor<'de> for TokenMetadataVisitor {
            type Value = TokenMetadata;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("struct TokenMetadata")
            }
            fn visit_seq<V>(self, mut seq: V) -> Result<TokenMetadata, V::Error>
            where
                V: SeqAccess<'de>,
            {
                let name = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(0, &self))?;
                let symbol = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(1, &self))?;
                let decimals = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(2, &self))?;
                let icon_url = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(3, &self))?;
                let total_supply = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(4, &self))?;
                let mintable = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(5, &self))?;
                let burnable = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(6, &self))?;
                let auth_hex: String = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(7, &self))?;
                let auth_bytes = hex_decode(&auth_hex).map_err(de::Error::custom)?;
                let mut reader = &auth_bytes[..];
                let authority = PublicKey::read(&mut reader)
                    .map_err(|_| de::Error::custom("invalid public key"))?;

                Ok(TokenMetadata {
                    name,
                    symbol,
                    decimals,
                    icon_url,
                    total_supply,
                    mintable,
                    burnable,
                    authority,
                })
            }

            fn visit_map<V>(self, mut map: V) -> Result<TokenMetadata, V::Error>
            where
                V: MapAccess<'de>,
            {
                let mut name = None;
                let mut symbol = None;
                let mut decimals = None;
                let mut icon_url = None;
                let mut total_supply = None;
                let mut mintable = None;
                let mut burnable = None;
                let mut authority = None;

                while let Some(key) = map.next_key()? {
                    match key {
                        Field::Name => {
                            if name.is_some() {
                                return Err(de::Error::duplicate_field("name"));
                            }
                            name = Some(map.next_value()?);
                        }
                        Field::Symbol => {
                            if symbol.is_some() {
                                return Err(de::Error::duplicate_field("symbol"));
                            }
                            symbol = Some(map.next_value()?);
                        }
                        Field::Decimals => {
                            if decimals.is_some() {
                                return Err(de::Error::duplicate_field("decimals"));
                            }
                            decimals = Some(map.next_value()?);
                        }
                        Field::IconUrl => {
                            if icon_url.is_some() {
                                return Err(de::Error::duplicate_field("icon_url"));
                            }
                            icon_url = Some(map.next_value()?);
                        }
                        Field::TotalSupply => {
                            if total_supply.is_some() {
                                return Err(de::Error::duplicate_field("total_supply"));
                            }
                            total_supply = Some(map.next_value()?);
                        }
                        Field::Mintable => {
                            if mintable.is_some() {
                                return Err(de::Error::duplicate_field("mintable"));
                            }
                            mintable = Some(map.next_value()?);
                        }
                        Field::Burnable => {
                            if burnable.is_some() {
                                return Err(de::Error::duplicate_field("burnable"));
                            }
                            burnable = Some(map.next_value()?);
                        }
                        Field::Authority => {
                            if authority.is_some() {
                                return Err(de::Error::duplicate_field("authority"));
                            }
                            let s: String = map.next_value()?;
                            let bytes = hex_decode(&s).map_err(de::Error::custom)?;
                            let mut reader = &bytes[..];
                            authority = Some(
                                PublicKey::read(&mut reader)
                                    .map_err(|_| de::Error::custom("invalid public key"))?,
                            );
                        }
                    }
                }
                let name = name.ok_or_else(|| de::Error::missing_field("name"))?;
                let symbol = symbol.ok_or_else(|| de::Error::missing_field("symbol"))?;
                let decimals = decimals.ok_or_else(|| de::Error::missing_field("decimals"))?;
                let total_supply =
                    total_supply.ok_or_else(|| de::Error::missing_field("total_supply"))?;
                let mintable = mintable.ok_or_else(|| de::Error::missing_field("mintable"))?;
                let burnable = burnable.ok_or_else(|| de::Error::missing_field("burnable"))?;
                let authority = authority.ok_or_else(|| de::Error::missing_field("authority"))?;

                Ok(TokenMetadata {
                    name,
                    symbol,
                    decimals,
                    icon_url,
                    total_supply,
                    mintable,
                    burnable,
                    authority,
                })
            }
        }
        deserializer.deserialize_struct("TokenMetadata", FIELDS, TokenMetadataVisitor)
    }
}

/// Represents a token balance and allowances
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct TokenAccount {
    pub balance: u64,
    pub frozen: bool,
    // simplistic allowance map: spender -> amount
    pub allowances: Vec<(PublicKey, u64)>,
}

const MAX_ALLOWANCES_JSON_PREALLOC: usize = 1024;

impl TokenAccount {
    pub fn allowance(&self, spender: &PublicKey) -> u64 {
        self.allowances
            .iter()
            .find(|(pk, _)| pk == spender)
            .map(|(_, amt)| *amt)
            .unwrap_or(0)
    }

    pub fn set_allowance(&mut self, spender: PublicKey, amount: u64) {
        if let Some(pos) = self.allowances.iter().position(|(pk, _)| pk == &spender) {
            self.allowances[pos].1 = amount;
        } else {
            self.allowances.push((spender, amount));
        }
    }
}

// Manual Serialize/Deserialize for TokenAccount
impl Serialize for TokenAccount {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("TokenAccount", 3)?;
        state.serialize_field("balance", &self.balance)?;
        state.serialize_field("frozen", &self.frozen)?;

        let allowances_serializable: Vec<(String, u64)> = self
            .allowances
            .iter()
            .map(|(pk, amt)| (hex_encode(pk.as_ref()), *amt))
            .collect();
        state.serialize_field("allowances", &allowances_serializable)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for TokenAccount {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        enum Field {
            Balance,
            Frozen,
            Allowances,
        }
        impl<'de> Deserialize<'de> for Field {
            fn deserialize<D>(deserializer: D) -> Result<Field, D::Error>
            where
                D: Deserializer<'de>,
            {
                struct FieldVisitor;
                impl<'de> Visitor<'de> for FieldVisitor {
                    type Value = Field;
                    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                        formatter.write_str("field identifier")
                    }
                    fn visit_str<E>(self, value: &str) -> Result<Field, E>
                    where
                        E: de::Error,
                    {
                        match value {
                            "balance" => Ok(Field::Balance),
                            "frozen" => Ok(Field::Frozen),
                            "allowances" => Ok(Field::Allowances),
                            _ => Err(de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(FieldVisitor)
            }
        }
        struct TokenAccountVisitor;
        const FIELDS: &[&str] = &["balance", "frozen", "allowances"];

        impl<'de> Visitor<'de> for TokenAccountVisitor {
            type Value = TokenAccount;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("struct TokenAccount")
            }
            fn visit_seq<V>(self, mut seq: V) -> Result<TokenAccount, V::Error>
            where
                V: SeqAccess<'de>,
            {
                let balance = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(0, &self))?;
                let frozen = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(1, &self))?;
                let allowances_raw: Vec<(String, u64)> = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(2, &self))?;

                let mut allowances =
                    Vec::with_capacity(allowances_raw.len().min(MAX_ALLOWANCES_JSON_PREALLOC));
                for (s, amt) in allowances_raw {
                    let bytes = hex_decode(&s).map_err(de::Error::custom)?;
                    let mut reader = &bytes[..];
                    let pk = PublicKey::read(&mut reader)
                        .map_err(|_| de::Error::custom("invalid public key"))?;
                    allowances.push((pk, amt));
                }
                Ok(TokenAccount {
                    balance,
                    frozen,
                    allowances,
                })
            }

            fn visit_map<V>(self, mut map: V) -> Result<TokenAccount, V::Error>
            where
                V: MapAccess<'de>,
            {
                let mut balance = None;
                let mut frozen = None;
                let mut allowances = None;
                while let Some(key) = map.next_key()? {
                    match key {
                        Field::Balance => {
                            if balance.is_some() {
                                return Err(de::Error::duplicate_field("balance"));
                            }
                            balance = Some(map.next_value()?);
                        }
                        Field::Frozen => {
                            if frozen.is_some() {
                                return Err(de::Error::duplicate_field("frozen"));
                            }
                            frozen = Some(map.next_value()?);
                        }
                        Field::Allowances => {
                            if allowances.is_some() {
                                return Err(de::Error::duplicate_field("allowances"));
                            }
                            let allowances_raw: Vec<(String, u64)> = map.next_value()?;
                            let mut list = Vec::with_capacity(
                                allowances_raw.len().min(MAX_ALLOWANCES_JSON_PREALLOC),
                            );
                            for (s, amt) in allowances_raw {
                                let bytes = hex_decode(&s).map_err(de::Error::custom)?;
                                let mut reader = &bytes[..];
                                let pk = PublicKey::read(&mut reader)
                                    .map_err(|_| de::Error::custom("invalid public key"))?;
                                list.push((pk, amt));
                            }
                            allowances = Some(list);
                        }
                    }
                }
                let balance = balance.ok_or_else(|| de::Error::missing_field("balance"))?;
                let frozen = frozen.ok_or_else(|| de::Error::missing_field("frozen"))?;
                let allowances =
                    allowances.ok_or_else(|| de::Error::missing_field("allowances"))?;
                Ok(TokenAccount {
                    balance,
                    frozen,
                    allowances,
                })
            }
        }
        deserializer.deserialize_struct("TokenAccount", FIELDS, TokenAccountVisitor)
    }
}

// Binary Serialization Implementation

impl Write for TokenMetadata {
    fn write(&self, writer: &mut impl BufMut) {
        crate::casino::write_string(&self.name, writer);
        crate::casino::write_string(&self.symbol, writer);
        self.decimals.write(writer);
        match &self.icon_url {
            Some(url) => {
                true.write(writer);
                crate::casino::write_string(url, writer);
            }
            None => false.write(writer),
        }
        self.total_supply.write(writer);
        self.mintable.write(writer);
        self.burnable.write(writer);
        self.authority.write(writer);
    }
}

impl Read for TokenMetadata {
    type Cfg = ();
    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, commonware_codec::Error> {
        let name = crate::casino::read_string(reader, 32)?;
        let symbol = crate::casino::read_string(reader, 8)?;
        let decimals = u8::read(reader)?;
        let has_icon = bool::read(reader)?;
        let icon_url = if has_icon {
            Some(crate::casino::read_string(reader, 256)?)
        } else {
            None
        };
        let total_supply = u64::read(reader)?;
        let mintable = bool::read(reader)?;
        let burnable = bool::read(reader)?;
        let authority = PublicKey::read(reader)?;

        Ok(Self {
            name,
            symbol,
            decimals,
            icon_url,
            total_supply,
            mintable,
            burnable,
            authority,
        })
    }
}

impl EncodeSize for TokenMetadata {
    fn encode_size(&self) -> usize {
        crate::casino::string_encode_size(&self.name)
            + crate::casino::string_encode_size(&self.symbol)
            + u8::SIZE
            + bool::SIZE
            + self
                .icon_url
                .as_ref()
                .map(|s| crate::casino::string_encode_size(s))
                .unwrap_or(0)
            + u64::SIZE
            + bool::SIZE
            + bool::SIZE
            + PublicKey::SIZE
    }
}

impl Write for TokenAccount {
    fn write(&self, writer: &mut impl BufMut) {
        self.balance.write(writer);
        self.frozen.write(writer);
        (self.allowances.len() as u32).write(writer);
        for (spender, amount) in &self.allowances {
            spender.write(writer);
            amount.write(writer);
        }
    }
}

impl Read for TokenAccount {
    type Cfg = ();
    fn read_cfg(reader: &mut impl Buf, _: &Self::Cfg) -> Result<Self, commonware_codec::Error> {
        let balance = u64::read(reader)?;
        let frozen = bool::read(reader)?;
        let allowance_count = u32::read(reader)?;
        let entry_size = PublicKey::SIZE + u64::SIZE;
        let max_possible = reader.remaining() / entry_size;
        let initial_capacity = (allowance_count as usize).min(max_possible);
        let mut allowances = Vec::with_capacity(initial_capacity);
        for _ in 0..allowance_count {
            let spender = PublicKey::read(reader)?;
            let amount = u64::read(reader)?;
            allowances.push((spender, amount));
        }
        Ok(Self {
            balance,
            frozen,
            allowances,
        })
    }
}

impl EncodeSize for TokenAccount {
    fn encode_size(&self) -> usize {
        u64::SIZE + bool::SIZE + u32::SIZE + self.allowances.len() * (PublicKey::SIZE + u64::SIZE)
    }
}
