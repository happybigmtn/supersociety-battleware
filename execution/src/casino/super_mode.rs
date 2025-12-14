//! Super Mode multiplier generation and application.
//!
//! This module implements the "Lightning/Quantum/Strike" style super mode
//! features for all casino games, providing random multiplier generation
//! and application logic.

use super::GameRng;
use nullspace_types::casino::{SuperModeState, SuperMultiplier, SuperType};

/// Generate Lightning Baccarat multipliers (3-5 Aura Cards, 2-8x)
///
/// Distribution per plan:
/// - Card count: 60% 3 cards, 30% 4 cards, 10% 5 cards
/// - Multipliers: 35% 2x, 30% 3x, 20% 4x, 10% 5x, 5% 8x
/// - Expected multiplier per card: 3.1x
/// - Max multiplier: 8^5 = 32,768x (capped at 512x for sustainability)
pub fn generate_baccarat_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 3-5 cards based on probability (60/30/10)
    let roll = rng.next_f32();
    let count = if roll < 0.6 {
        3
    } else if roll < 0.9 {
        4
    } else {
        5
    };

    let mut mults = Vec::with_capacity(count);
    let mut used_cards = 0u64; // Bit set

    for _ in 0..count {
        // Pick unused card (0-51)
        let card = loop {
            let c = rng.next_u8() % 52;
            if (used_cards & (1 << c)) == 0 {
                used_cards |= 1 << c;
                break c;
            }
        };

        // Assign multiplier: 35% 2x, 30% 3x, 20% 4x, 10% 5x, 5% 8x
        let m_roll = rng.next_f32();
        let multiplier = if m_roll < 0.35 {
            2
        } else if m_roll < 0.65 {
            3
        } else if m_roll < 0.85 {
            4
        } else if m_roll < 0.95 {
            5
        } else {
            8
        };

        mults.push(SuperMultiplier {
            id: card,
            multiplier,
            super_type: SuperType::Card,
        });
    }
    mults
}

/// Generate Quantum Roulette multipliers (5-7 numbers, 50-500x)
pub fn generate_roulette_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 5-7 numbers
    let count = 5 + (rng.next_u8() % 3) as usize;
    let mut mults = Vec::with_capacity(count);
    let mut used = 0u64;

    for _ in 0..count {
        // Pick unused number (0-36)
        let num = loop {
            let n = rng.next_u8() % 37;
            if (used & (1 << n)) == 0 {
                used |= 1 << n;
                break n;
            }
        };

        // Assign multiplier (50, 100, 200, 300, 400, 500x)
        let roll = rng.next_f32();
        let multiplier = if roll < 0.35 {
            50
        } else if roll < 0.65 {
            100
        } else if roll < 0.83 {
            200
        } else if roll < 0.93 {
            300
        } else if roll < 0.98 {
            400
        } else {
            500
        };

        mults.push(SuperMultiplier {
            id: num,
            multiplier,
            super_type: SuperType::Number,
        });
    }
    mults
}

/// Generate Strike Blackjack multipliers (5 Strike Cards, 2-10x)
///
/// Distribution per plan:
/// - 5 Strike Cards (specific rank+suit)
/// - Multipliers: 40% 2x, 30% 3x, 20% 5x, 7% 7x, 3% 10x
/// - Player Blackjack: Guaranteed minimum 2x multiplier
/// - Maximum: 10x × 10x × 2x = 200x
/// - Hit Frequency: ~12.5% in winning hands
pub fn generate_blackjack_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    let mut mults = Vec::with_capacity(5);
    let mut used = 0u64;

    for _ in 0..5 {
        let card = loop {
            let c = rng.next_u8() % 52;
            if (used & (1 << c)) == 0 {
                used |= 1 << c;
                break c;
            }
        };

        // Distribution: 40% 2x, 30% 3x, 20% 5x, 7% 7x, 3% 10x
        let roll = rng.next_f32();
        let multiplier = if roll < 0.40 {
            2
        } else if roll < 0.70 {
            3
        } else if roll < 0.90 {
            5
        } else if roll < 0.97 {
            7
        } else {
            10
        };

        mults.push(SuperMultiplier {
            id: card,
            multiplier,
            super_type: SuperType::Card,
        });
    }
    mults
}

/// Generate Thunder Craps multipliers (3 numbers from [4,5,6,8,9,10], 3-25x)
pub fn generate_craps_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 3 numbers from [4,5,6,8,9,10]
    let opts = [4u8, 5, 6, 8, 9, 10];
    let mut indices = [0, 1, 2, 3, 4, 5];

    // Fisher-Yates shuffle first 3
    for i in 0..3 {
        let j = i + (rng.next_u8() as usize % (6 - i));
        indices.swap(i, j);
    }

    let mut mults = Vec::with_capacity(3);
    for i in 0..3 {
        let num = opts[indices[i]];
        let roll = rng.next_f32();

        // Multiplier based on point difficulty
        let multiplier = if roll < 0.05 {
            25 // Rare 5%
        } else {
            match num {
                6 | 8 => 3,   // Easy points
                5 | 9 => 5,   // Medium points
                4 | 10 => 10, // Hard points
                _ => 3,
            }
        };

        mults.push(SuperMultiplier {
            id: num,
            multiplier,
            super_type: SuperType::Total,
        });
    }
    mults
}

/// Generate Fortune Sic Bo multipliers (3 totals from 4-17, 3-50x)
pub fn generate_sic_bo_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 3 totals from 4-17
    let mut mults = Vec::with_capacity(3);
    let mut used = 0u32;

    for _ in 0..3 {
        let total = loop {
            let t = 4 + (rng.next_u8() % 14); // 4-17
            if (used & (1 << t)) == 0 {
                used |= 1 << t;
                break t;
            }
        };

        // Multiplier based on probability (center totals easier)
        let multiplier = match total {
            10 | 11 => 3 + (rng.next_u8() % 3) as u16,         // 3-5x
            7 | 8 | 13 | 14 => 5 + (rng.next_u8() % 6) as u16, // 5-10x
            _ => 10 + (rng.next_u8() % 41) as u16,             // 10-50x (edges)
        };

        mults.push(SuperMultiplier {
            id: total,
            multiplier,
            super_type: SuperType::Total,
        });
    }
    mults
}

/// Generate Mega Video Poker multipliers (4 Mega Cards)
///
/// Distribution per plan (COUNT-BASED multipliers):
/// - 4 Mega Cards selected (specific rank+suit, revealed before draw)
/// - Multiplier based on count in final hand:
///   - 1 Mega Card: 1.5x (stored as 15, divide by 10 when applying)
///   - 2 Mega Cards: 3x
///   - 3 Mega Cards: 10x
///   - 4 Mega Cards: 100x
///   - Mega Card in Royal Flush: 1000x
/// - Hit Frequency: ~35% for at least 1 Mega
///
/// NOTE: This stores a base marker multiplier of 1. The actual payout
/// calculation should use `apply_video_poker_mega_multiplier()` which
/// counts matching cards and applies count-based multipliers.
pub fn generate_video_poker_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    let mut mults = Vec::with_capacity(4);
    let mut used = 0u64;

    for _ in 0..4 {
        let card = loop {
            let c = rng.next_u8() % 52;
            if (used & (1 << c)) == 0 {
                used |= 1 << c;
                break c;
            }
        };

        // Store 1 as marker - actual multiplier is count-based
        mults.push(SuperMultiplier {
            id: card,
            multiplier: 1, // Marker for count-based system
            super_type: SuperType::Card,
        });
    }
    mults
}

/// Apply Video Poker Mega multiplier based on count of Mega Cards in hand
///
/// Returns the boosted payout based on how many Mega Cards are in the final hand.
pub fn apply_video_poker_mega_multiplier(
    hand_cards: &[u8],
    multipliers: &[SuperMultiplier],
    base_payout: u64,
    is_royal_flush: bool,
) -> u64 {
    let mut mega_count = 0;
    let mut has_mega_in_royal = false;

    for card in hand_cards {
        for m in multipliers {
            if m.super_type == SuperType::Card && *card == m.id {
                mega_count += 1;
                if is_royal_flush {
                    has_mega_in_royal = true;
                }
            }
        }
    }

    // Apply count-based multiplier
    let multiplier: u64 = if has_mega_in_royal {
        1000
    } else {
        match mega_count {
            0 => 1,
            1 => 15, // 1.5x stored as 15, caller divides by 10
            2 => 30, // 3x stored as 30
            3 => 100,
            _ => 1000, // 4+ Mega Cards
        }
    };

    // For fractional multipliers, multiply then divide
    if mega_count == 1 && !has_mega_in_royal {
        base_payout.saturating_mul(15) / 10
    } else if mega_count == 2 && !has_mega_in_royal {
        base_payout.saturating_mul(3)
    } else {
        base_payout.saturating_mul(multiplier)
    }
}

/// Generate Flash Three Card Poker multipliers (2 Flash Suits)
///
/// Distribution per plan (CONFIGURATION-BASED multipliers):
/// - 2 Flash Suits selected (26 cards = half deck eligible)
/// - Multiplier based on hand configuration:
///   - 2 cards same Flash Suit: 2x
///   - 3 cards same Flash Suit (Flush): 5x
///   - Flash Suit Straight: 4x
///   - Flash Suit Straight Flush: 25x
/// - Hit Frequency: ~29% for 2+ cards in same Flash Suit
///
/// NOTE: Use `apply_three_card_flash_multiplier()` for proper
/// configuration-based multiplier application.
pub fn generate_three_card_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 2 Flash Suits
    let suit1 = rng.next_u8() % 4;
    let suit2 = loop {
        let s = rng.next_u8() % 4;
        if s != suit1 {
            break s;
        }
    };

    vec![
        SuperMultiplier {
            id: suit1,
            multiplier: 1, // Marker for config-based system
            super_type: SuperType::Suit,
        },
        SuperMultiplier {
            id: suit2,
            multiplier: 1,
            super_type: SuperType::Suit,
        },
    ]
}

/// Apply Three Card Poker Flash multiplier based on hand configuration
///
/// Returns the boosted payout based on Flash Suit matches in the hand.
pub fn apply_three_card_flash_multiplier(
    hand_cards: &[u8], // 3 cards, each 0-51
    multipliers: &[SuperMultiplier],
    base_payout: u64,
    is_straight: bool,
    is_flush: bool,
) -> u64 {
    // Count cards in each Flash Suit
    let mut flash_suit_counts = [0u8; 4];
    for card in hand_cards {
        let suit = card / 13;
        for m in multipliers {
            if m.super_type == SuperType::Suit && suit == m.id {
                flash_suit_counts[suit as usize] += 1;
            }
        }
    }

    let max_flash_count = flash_suit_counts.iter().max().copied().unwrap_or(0);

    // Determine multiplier based on configuration
    let multiplier: u64 = if is_flush && is_straight && max_flash_count == 3 {
        // Flash Suit Straight Flush
        25
    } else if is_flush && max_flash_count == 3 {
        // 3 cards same Flash Suit (Flush)
        5
    } else if is_straight && max_flash_count >= 2 {
        // Flash Suit Straight (at least 2 cards in Flash Suit)
        4
    } else if max_flash_count >= 2 {
        // 2+ cards in same Flash Suit
        2
    } else {
        1
    };

    base_payout.saturating_mul(multiplier)
}

/// Generate Blitz Ultimate Texas Hold'em multipliers (2 Blitz Ranks)
///
/// Distribution per plan (HAND-STRENGTH-BASED multipliers):
/// - 2 Blitz ranks selected (any suit matches = 8 cards from 52 eligible)
/// - Multiplier based on hand strength when Blitz card in winning hand:
///   - Pair: 2x
///   - Two Pair: 3x
///   - Three of a Kind: 5x
///   - Straight: 4x
///   - Flush: 4x
///   - Full House: 6x
///   - Four of a Kind: 15x
///   - Straight Flush: 25x
///   - Royal Flush: 50x
/// - Special: Both hole cards Blitz + win = automatic 5x
/// - Hit Frequency: ~63% Blitz in 7 cards, ~18% in winning pair+
///
/// NOTE: Use `apply_uth_blitz_multiplier()` for proper hand-based multiplier.
pub fn generate_uth_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 2 Blitz ranks (any suit matches)
    let rank1 = rng.next_u8() % 13;
    let rank2 = loop {
        let r = rng.next_u8() % 13;
        if r != rank1 {
            break r;
        }
    };

    vec![
        SuperMultiplier {
            id: rank1,
            multiplier: 1, // Marker for hand-based system
            super_type: SuperType::Rank,
        },
        SuperMultiplier {
            id: rank2,
            multiplier: 1,
            super_type: SuperType::Rank,
        },
    ]
}

/// Hand ranking for UTH Blitz multiplier
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum UthHandRank {
    HighCard,
    Pair,
    TwoPair,
    ThreeOfAKind,
    Straight,
    Flush,
    FullHouse,
    FourOfAKind,
    StraightFlush,
    RoyalFlush,
}

/// Apply UTH Blitz multiplier based on hand strength
///
/// Returns the boosted payout based on Blitz ranks in the winning hand.
pub fn apply_uth_blitz_multiplier(
    final_hand: &[u8], // 5-card final hand
    hole_cards: &[u8], // 2 player hole cards
    multipliers: &[SuperMultiplier],
    base_payout: u64,
    hand_rank: UthHandRank,
) -> u64 {
    // Check if any card in final hand is a Blitz rank
    let has_blitz_in_hand = final_hand.iter().any(|card| {
        let rank = card % 13;
        multipliers
            .iter()
            .any(|m| m.super_type == SuperType::Rank && rank == m.id)
    });

    if !has_blitz_in_hand {
        return base_payout;
    }

    // Check for double Blitz hole cards bonus
    let both_hole_cards_blitz = hole_cards.iter().all(|card| {
        let rank = card % 13;
        multipliers
            .iter()
            .any(|m| m.super_type == SuperType::Rank && rank == m.id)
    });

    // Determine base multiplier from hand strength
    let hand_mult: u64 = match hand_rank {
        UthHandRank::HighCard => 1,
        UthHandRank::Pair => 2,
        UthHandRank::TwoPair => 3,
        UthHandRank::ThreeOfAKind => 5,
        UthHandRank::Straight => 4,
        UthHandRank::Flush => 4,
        UthHandRank::FullHouse => 6,
        UthHandRank::FourOfAKind => 15,
        UthHandRank::StraightFlush => 25,
        UthHandRank::RoyalFlush => 50,
    };

    // Apply both hole cards Blitz bonus (automatic 5x if better)
    let final_mult = if both_hole_cards_blitz && hand_mult < 5 {
        5
    } else {
        hand_mult
    };

    base_payout.saturating_mul(final_mult)
}

/// Generate Strike Casino War multipliers (3 Strike Ranks)
///
/// Distribution per plan (SCENARIO-BASED multipliers):
/// - 3 Strike Ranks selected (any suit = 24 cards per rank in 6-deck shoe)
/// - Multiplier based on scenario:
///   - Your card is Strike Rank, win: 2x
///   - Both cards Strike Rank, win war: 3x
///   - Both cards same Strike Rank (tie), win war: 5x
/// - Hit Frequency: 3/13 = 23.08% for your card being Strike
/// - Special: War Bonus Wheel has 10% chance to add 2x-5x boost
///
/// NOTE: Use `apply_casino_war_strike_multiplier()` for proper scenario-based multiplier.
pub fn generate_casino_war_multipliers(rng: &mut GameRng) -> Vec<SuperMultiplier> {
    // 3 Strike Ranks
    let mut mults = Vec::with_capacity(3);
    let mut used = 0u16;

    for _ in 0..3 {
        let rank = loop {
            let r = rng.next_u8() % 13;
            if (used & (1 << r)) == 0 {
                used |= 1 << r;
                break r;
            }
        };

        mults.push(SuperMultiplier {
            id: rank,
            multiplier: 1, // Marker for scenario-based system
            super_type: SuperType::Rank,
        });
    }
    mults
}

/// Apply Casino War Strike multiplier based on scenario
///
/// Returns the boosted payout based on Strike Rank matches.
pub fn apply_casino_war_strike_multiplier(
    player_card: u8, // 0-51
    dealer_card: u8, // 0-51
    multipliers: &[SuperMultiplier],
    base_payout: u64,
    won_war: bool, // True if player won after going to war
    was_tie: bool, // True if original cards tied
) -> u64 {
    let player_rank = player_card % 13;
    let dealer_rank = dealer_card % 13;

    let player_is_strike = multipliers
        .iter()
        .any(|m| m.super_type == SuperType::Rank && player_rank == m.id);
    let dealer_is_strike = multipliers
        .iter()
        .any(|m| m.super_type == SuperType::Rank && dealer_rank == m.id);

    // Determine multiplier based on scenario
    let multiplier: u64 = if was_tie && player_rank == dealer_rank && player_is_strike && won_war {
        // Both cards same Strike Rank (tie), won war
        5
    } else if player_is_strike && dealer_is_strike && won_war {
        // Both cards Strike Rank, won war
        3
    } else if player_is_strike {
        // Your card is Strike Rank, win
        2
    } else {
        1
    };

    base_payout.saturating_mul(multiplier)
}

/// Generate Super HiLo state (streak-based progressive multipliers)
///
/// Distribution per plan (STREAK-BASED multipliers):
/// | Correct Calls | Multiplier | Probability from Start |
/// |---------------|-----------|----------------------|
/// | 1             | 1.5x      | ~50%                 |
/// | 2             | 2.5x      | ~25%                 |
/// | 3             | 4x        | ~12.5%               |
/// | 4             | 7x        | ~6.25%               |
/// | 5             | 12x       | ~3.13%               |
/// | 6             | 20x       | ~1.56%               |
/// | 7             | 35x       | ~0.78%               |
/// | 8             | 60x       | ~0.39%               |
/// | 9             | 100x      | ~0.20%               |
/// | 10+           | 200x      | ~0.10%               |
///
/// - Ace Bonus: Correct call on Ace = 3x multiplier boost
/// - Stored as x10 for fractional values (15 = 1.5x, 25 = 2.5x)
pub fn generate_hilo_state(streak: u8) -> SuperModeState {
    // Streak-based progressive multipliers (stored as x10 for 1.5x and 2.5x)
    let base_mult = match streak {
        0 | 1 => 15, // 1.5x
        2 => 25,     // 2.5x
        3 => 40,     // 4x
        4 => 70,     // 7x
        5 => 120,    // 12x
        6 => 200,    // 20x
        7 => 350,    // 35x
        8 => 600,    // 60x
        9 => 1000,   // 100x
        _ => 2000,   // 200x (10+ streaks)
    };

    SuperModeState {
        is_active: true,
        multipliers: vec![SuperMultiplier {
            id: 0,
            multiplier: base_mult,
            super_type: SuperType::Card, // Unused, placeholder
        }],
        streak_level: streak,
    }
}

/// Apply HiLo streak multiplier to payout
///
/// Handles the x10 storage format for fractional multipliers.
pub fn apply_hilo_streak_multiplier(base_payout: u64, streak: u8, was_ace: bool) -> u64 {
    let mult = match streak {
        0 | 1 => 15, // 1.5x
        2 => 25,     // 2.5x
        3 => 40,     // 4x
        4 => 70,     // 7x
        5 => 120,    // 12x
        6 => 200,    // 20x
        7 => 350,    // 35x
        8 => 600,    // 60x
        9 => 1000,   // 100x
        _ => 2000,   // 200x
    };

    // Apply Ace bonus (3x boost) if applicable
    let final_mult = if was_ace { mult * 3 } else { mult };

    // Divide by 10 to handle fractional storage
    base_payout.saturating_mul(final_mult as u64) / 10
}

/// Apply super multiplier for card-based games
///
/// Returns the boosted payout if any winning cards match the super multipliers.
/// Multipliers stack multiplicatively.
pub fn apply_super_multiplier_cards(
    winning_cards: &[u8],
    multipliers: &[SuperMultiplier],
    base_payout: u64,
) -> u64 {
    let mut total_mult: u64 = 1;

    for card in winning_cards {
        for m in multipliers {
            let matches = match m.super_type {
                SuperType::Card => *card == m.id,
                SuperType::Rank => (*card % 13) == m.id,
                SuperType::Suit => (*card / 13) == m.id,
                _ => false,
            };
            if matches {
                total_mult = total_mult.saturating_mul(m.multiplier as u64);
            }
        }
    }

    base_payout.saturating_mul(total_mult)
}

/// Apply super multiplier for number-based games (Roulette)
///
/// Returns the boosted payout if the result matches a super multiplier.
pub fn apply_super_multiplier_number(
    result: u8,
    multipliers: &[SuperMultiplier],
    base_payout: u64,
) -> u64 {
    for m in multipliers {
        if m.super_type == SuperType::Number && m.id == result {
            return base_payout.saturating_mul(m.multiplier as u64);
        }
    }
    base_payout
}

/// Apply super multiplier for total-based games (Sic Bo)
///
/// Returns the boosted payout if the total matches a super multiplier.
pub fn apply_super_multiplier_total(
    total: u8,
    multipliers: &[SuperMultiplier],
    base_payout: u64,
) -> u64 {
    for m in multipliers {
        if m.super_type == SuperType::Total && m.id == total {
            return base_payout.saturating_mul(m.multiplier as u64);
        }
    }
    base_payout
}

// ============================================================================
// Aura Meter System (Cross-Game Feature)
// ============================================================================

/// Maximum Aura Meter value (triggers Super Aura Round)
pub const AURA_METER_MAX: u8 = 5;

/// Update the player's Aura Meter based on round outcome.
///
/// The meter increments when:
/// - Player paid Super Mode fee (implied by calling this function)
/// - Player lost the round (won = false)
/// - At least one Aura element appeared in the round
///
/// Returns the new meter value.
pub fn update_aura_meter(current_meter: u8, had_aura_element: bool, won: bool) -> u8 {
    if had_aura_element && !won {
        // Near-miss: Aura element appeared but player lost
        (current_meter + 1).min(AURA_METER_MAX)
    } else if won {
        // Win resets the meter (they got their bonus)
        0
    } else {
        // No Aura element, keep current value
        current_meter
    }
}

/// Check if the player qualifies for a Super Aura Round.
///
/// At 5/5 meter, the next round becomes a Super Aura Round with:
/// - Enhanced multiplier distribution (all multipliers × 1.5)
/// - Guaranteed at least one Aura element in player's outcome area
pub fn is_super_aura_round(aura_meter: u8) -> bool {
    aura_meter >= AURA_METER_MAX
}

/// Reset the Aura Meter after a Super Aura Round completes.
pub fn reset_aura_meter() -> u8 {
    0
}

/// Generate enhanced multipliers for Super Aura Round.
///
/// Takes base multipliers and boosts them by 1.5x (rounded down).
pub fn enhance_multipliers_for_aura_round(multipliers: &mut [SuperMultiplier]) {
    for m in multipliers {
        // Multiply by 1.5 (3/2)
        m.multiplier = (m.multiplier * 3) / 2;
    }
}

/// Check if any of the outcome elements match Aura elements.
///
/// Used to determine if the round qualifies as a "near-miss" for meter purposes.
pub fn check_aura_element_presence(
    outcome_cards: &[u8],
    outcome_numbers: &[u8],
    outcome_totals: &[u8],
    multipliers: &[SuperMultiplier],
) -> bool {
    // Check cards
    for card in outcome_cards {
        for m in multipliers {
            let matches = match m.super_type {
                SuperType::Card => *card == m.id,
                SuperType::Rank => (*card % 13) == m.id,
                SuperType::Suit => (*card / 13) == m.id,
                _ => false,
            };
            if matches {
                return true;
            }
        }
    }

    // Check numbers
    for num in outcome_numbers {
        for m in multipliers {
            if m.super_type == SuperType::Number && *num == m.id {
                return true;
            }
        }
    }

    // Check totals
    for total in outcome_totals {
        for m in multipliers {
            if m.super_type == SuperType::Total && *total == m.id {
                return true;
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mocks::{create_network_keypair, create_seed};

    fn create_test_rng(session_id: u64) -> GameRng {
        let (network_secret, _) = create_network_keypair();
        let seed = create_seed(&network_secret, 1);
        GameRng::new(&seed, session_id, 0)
    }

    #[test]
    fn test_generate_baccarat_multipliers() {
        let mut rng = create_test_rng(1);
        let mults = generate_baccarat_multipliers(&mut rng);

        // Now 3-5 cards (was 1-5)
        assert!(mults.len() >= 3 && mults.len() <= 5);
        for m in &mults {
            assert!(m.id < 52);
            assert!(m.multiplier >= 2 && m.multiplier <= 8);
            assert_eq!(m.super_type, SuperType::Card);
        }

        // Check no duplicates
        let mut seen = [false; 52];
        for m in &mults {
            assert!(!seen[m.id as usize]);
            seen[m.id as usize] = true;
        }
    }

    #[test]
    fn test_generate_roulette_multipliers() {
        let mut rng = create_test_rng(2);
        let mults = generate_roulette_multipliers(&mut rng);

        assert!(mults.len() >= 5 && mults.len() <= 7);
        for m in &mults {
            assert!(m.id <= 36);
            assert!(m.multiplier >= 50 && m.multiplier <= 500);
            assert_eq!(m.super_type, SuperType::Number);
        }
    }

    #[test]
    fn test_generate_blackjack_multipliers() {
        let mut rng = create_test_rng(3);
        let mults = generate_blackjack_multipliers(&mut rng);

        // Now 5 Strike Cards (was 3)
        assert_eq!(mults.len(), 5);
        for m in &mults {
            assert!(m.id < 52);
            assert!(m.multiplier >= 2 && m.multiplier <= 10);
            assert_eq!(m.super_type, SuperType::Card);
        }
    }

    #[test]
    fn test_generate_craps_multipliers() {
        let mut rng = create_test_rng(4);
        let mults = generate_craps_multipliers(&mut rng);

        assert_eq!(mults.len(), 3);
        for m in &mults {
            assert!([4, 5, 6, 8, 9, 10].contains(&m.id));
            assert!(m.multiplier >= 3 && m.multiplier <= 25);
            assert_eq!(m.super_type, SuperType::Total);
        }
    }

    #[test]
    fn test_generate_sic_bo_multipliers() {
        let mut rng = create_test_rng(5);
        let mults = generate_sic_bo_multipliers(&mut rng);

        assert_eq!(mults.len(), 3);
        for m in &mults {
            assert!(m.id >= 4 && m.id <= 17);
            assert!(m.multiplier >= 3 && m.multiplier <= 50);
            assert_eq!(m.super_type, SuperType::Total);
        }
    }

    #[test]
    fn test_generate_video_poker_multipliers() {
        let mut rng = create_test_rng(6);
        let mults = generate_video_poker_multipliers(&mut rng);

        assert_eq!(mults.len(), 4);
        for m in &mults {
            assert!(m.id < 52);
            // Now uses marker multiplier=1 (actual multiplier is count-based)
            assert_eq!(m.multiplier, 1);
            assert_eq!(m.super_type, SuperType::Card);
        }
    }

    #[test]
    fn test_generate_three_card_multipliers() {
        let mut rng = create_test_rng(7);
        let mults = generate_three_card_multipliers(&mut rng);

        assert_eq!(mults.len(), 2);
        for m in &mults {
            assert!(m.id < 4);
            // Now uses marker multiplier=1 (actual multiplier is config-based)
            assert_eq!(m.multiplier, 1);
            assert_eq!(m.super_type, SuperType::Suit);
        }
        assert_ne!(mults[0].id, mults[1].id);
    }

    #[test]
    fn test_generate_uth_multipliers() {
        let mut rng = create_test_rng(8);
        let mults = generate_uth_multipliers(&mut rng);

        assert_eq!(mults.len(), 2);
        for m in &mults {
            assert!(m.id < 13);
            // Now uses marker multiplier=1 (actual multiplier is hand-based)
            assert_eq!(m.multiplier, 1);
            assert_eq!(m.super_type, SuperType::Rank);
        }
        assert_ne!(mults[0].id, mults[1].id);
    }

    #[test]
    fn test_generate_casino_war_multipliers() {
        let mut rng = create_test_rng(9);
        let mults = generate_casino_war_multipliers(&mut rng);

        assert_eq!(mults.len(), 3);
        for m in &mults {
            assert!(m.id < 13);
            // Now uses marker multiplier=1 (actual multiplier is scenario-based)
            assert_eq!(m.multiplier, 1);
            assert_eq!(m.super_type, SuperType::Rank);
        }
    }

    #[test]
    fn test_generate_hilo_state() {
        let state0 = generate_hilo_state(0);
        assert_eq!(state0.streak_level, 0);
        assert_eq!(state0.multipliers[0].multiplier, 15); // 1.5x

        let state2 = generate_hilo_state(2);
        assert_eq!(state2.streak_level, 2);
        assert_eq!(state2.multipliers[0].multiplier, 25); // 2.5x

        // Updated streak 5 now has 12x (120) instead of 4x (40)
        let state5 = generate_hilo_state(5);
        assert_eq!(state5.streak_level, 5);
        assert_eq!(state5.multipliers[0].multiplier, 120); // 12x

        // Test higher streaks
        let state10 = generate_hilo_state(10);
        assert_eq!(state10.streak_level, 10);
        assert_eq!(state10.multipliers[0].multiplier, 2000); // 200x
    }

    #[test]
    fn test_apply_super_multiplier_cards() {
        let multipliers = vec![
            SuperMultiplier {
                id: 0, // Ace of Spades
                multiplier: 5,
                super_type: SuperType::Card,
            },
            SuperMultiplier {
                id: 10, // Jack of Spades (rank=10, suit=0)
                multiplier: 2,
                super_type: SuperType::Rank,
            },
        ];

        // Winning with Ace of Spades
        let payout1 = apply_super_multiplier_cards(&[0], &multipliers, 100);
        assert_eq!(payout1, 500); // 100 * 5

        // Winning with Jack of Spades (matches rank multiplier)
        let payout2 = apply_super_multiplier_cards(&[10], &multipliers, 100);
        assert_eq!(payout2, 200); // 100 * 2

        // Winning with card that has no multiplier
        let payout3 = apply_super_multiplier_cards(&[25], &multipliers, 100);
        assert_eq!(payout3, 100); // No multiplier
    }

    #[test]
    fn test_apply_super_multiplier_number() {
        let multipliers = vec![SuperMultiplier {
            id: 17,
            multiplier: 100,
            super_type: SuperType::Number,
        }];

        let payout1 = apply_super_multiplier_number(17, &multipliers, 35);
        assert_eq!(payout1, 3500); // 35 * 100

        let payout2 = apply_super_multiplier_number(5, &multipliers, 35);
        assert_eq!(payout2, 35); // No multiplier
    }

    #[test]
    fn test_apply_super_multiplier_total() {
        let multipliers = vec![SuperMultiplier {
            id: 10,
            multiplier: 8,
            super_type: SuperType::Total,
        }];

        let payout1 = apply_super_multiplier_total(10, &multipliers, 60);
        assert_eq!(payout1, 480); // 60 * 8

        let payout2 = apply_super_multiplier_total(7, &multipliers, 60);
        assert_eq!(payout2, 60); // No multiplier
    }

    // ========== Aura Meter Tests ==========

    #[test]
    fn test_update_aura_meter_near_miss() {
        // Near-miss: had aura element but lost
        let new_meter = update_aura_meter(0, true, false);
        assert_eq!(new_meter, 1);

        let new_meter = update_aura_meter(4, true, false);
        assert_eq!(new_meter, 5);

        // Capped at 5
        let new_meter = update_aura_meter(5, true, false);
        assert_eq!(new_meter, 5);
    }

    #[test]
    fn test_update_aura_meter_win_resets() {
        // Win resets the meter
        let new_meter = update_aura_meter(3, true, true);
        assert_eq!(new_meter, 0);

        let new_meter = update_aura_meter(5, false, true);
        assert_eq!(new_meter, 0);
    }

    #[test]
    fn test_update_aura_meter_no_aura_element() {
        // No aura element, keep current
        let new_meter = update_aura_meter(3, false, false);
        assert_eq!(new_meter, 3);
    }

    #[test]
    fn test_is_super_aura_round() {
        assert!(!is_super_aura_round(0));
        assert!(!is_super_aura_round(4));
        assert!(is_super_aura_round(5));
        assert!(is_super_aura_round(6)); // Edge case
    }

    #[test]
    fn test_enhance_multipliers_for_aura_round() {
        let mut mults = vec![
            SuperMultiplier {
                id: 0,
                multiplier: 2,
                super_type: SuperType::Card,
            },
            SuperMultiplier {
                id: 1,
                multiplier: 8,
                super_type: SuperType::Card,
            },
        ];
        enhance_multipliers_for_aura_round(&mut mults);
        assert_eq!(mults[0].multiplier, 3); // 2 * 1.5 = 3
        assert_eq!(mults[1].multiplier, 12); // 8 * 1.5 = 12
    }

    #[test]
    fn test_check_aura_element_presence_cards() {
        let multipliers = vec![SuperMultiplier {
            id: 5,
            multiplier: 1,
            super_type: SuperType::Card,
        }];

        // Card matches
        assert!(check_aura_element_presence(&[5], &[], &[], &multipliers));
        // Card doesn't match
        assert!(!check_aura_element_presence(&[10], &[], &[], &multipliers));
    }

    #[test]
    fn test_check_aura_element_presence_numbers() {
        let multipliers = vec![SuperMultiplier {
            id: 17,
            multiplier: 100,
            super_type: SuperType::Number,
        }];

        // Number matches
        assert!(check_aura_element_presence(&[], &[17], &[], &multipliers));
        // Number doesn't match
        assert!(!check_aura_element_presence(&[], &[5], &[], &multipliers));
    }

    // ========== New Apply Function Tests ==========

    #[test]
    fn test_apply_video_poker_mega_multiplier() {
        let multipliers = vec![
            SuperMultiplier {
                id: 0,
                multiplier: 1,
                super_type: SuperType::Card,
            },
            SuperMultiplier {
                id: 1,
                multiplier: 1,
                super_type: SuperType::Card,
            },
            SuperMultiplier {
                id: 2,
                multiplier: 1,
                super_type: SuperType::Card,
            },
            SuperMultiplier {
                id: 3,
                multiplier: 1,
                super_type: SuperType::Card,
            },
        ];

        // 1 Mega Card = 1.5x
        let payout =
            apply_video_poker_mega_multiplier(&[0, 10, 20, 30, 40], &multipliers, 100, false);
        assert_eq!(payout, 150); // 100 * 1.5

        // 2 Mega Cards = 3x
        let payout =
            apply_video_poker_mega_multiplier(&[0, 1, 20, 30, 40], &multipliers, 100, false);
        assert_eq!(payout, 300); // 100 * 3

        // No Mega Cards = 1x
        let payout =
            apply_video_poker_mega_multiplier(&[10, 20, 30, 40, 50], &multipliers, 100, false);
        assert_eq!(payout, 100);
    }

    #[test]
    fn test_apply_hilo_streak_multiplier() {
        // Streak 1 = 1.5x -> 100 * 15 / 10 = 150
        let payout = apply_hilo_streak_multiplier(100, 1, false);
        assert_eq!(payout, 150);

        // Streak 3 = 4x -> 100 * 40 / 10 = 400
        let payout = apply_hilo_streak_multiplier(100, 3, false);
        assert_eq!(payout, 400);

        // Streak 5 = 12x -> 100 * 120 / 10 = 1200
        let payout = apply_hilo_streak_multiplier(100, 5, false);
        assert_eq!(payout, 1200);

        // Streak 10+ = 200x -> 100 * 2000 / 10 = 20000
        let payout = apply_hilo_streak_multiplier(100, 10, false);
        assert_eq!(payout, 20000);

        // Ace bonus: 3x extra on streak 3 = 12x -> 100 * 120 / 10 = 1200
        let payout = apply_hilo_streak_multiplier(100, 3, true);
        assert_eq!(payout, 1200);
    }

    #[test]
    fn test_apply_casino_war_strike_multiplier() {
        let multipliers = vec![
            SuperMultiplier {
                id: 5,
                multiplier: 1,
                super_type: SuperType::Rank,
            }, // Rank 5 (6s)
        ];

        // Player card is Strike (rank 5), win = 2x
        let payout = apply_casino_war_strike_multiplier(5, 10, &multipliers, 100, false, false);
        assert_eq!(payout, 200);

        // Neither card is Strike = 1x
        let payout = apply_casino_war_strike_multiplier(10, 11, &multipliers, 100, false, false);
        assert_eq!(payout, 100);
    }
}
