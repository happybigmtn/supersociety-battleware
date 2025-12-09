import { GameType, Card } from '../../types';

// Helper to format cards for prompt (kept for potential future backend proxy)
const formatCards = (cards: Card[]) => cards.map(c => `${c.rank}${c.suit}`).join(',');

/**
 * Get strategic advice for casino games.
 *
 * NOTE: AI integration disabled - API keys should not be exposed in frontend bundles.
 * TODO: Implement backend proxy at /api/ai/strategy if AI advice is needed.
 *
 * For now, returns basic strategy advice based on game rules.
 */
export const getStrategicAdvice = async (
  gameType: GameType,
  playerCards: Card[],
  dealerUpCard: Card | null,
  history: string[]
): Promise<string> => {
  // Return basic strategy advice without external API calls
  switch (gameType) {
    case GameType.BLACKJACK:
      return getBasicBlackjackAdvice(playerCards, dealerUpCard);
    case GameType.VIDEO_POKER:
      return "Hold high pairs and face cards. Discard low unmatched cards.";
    case GameType.BACCARAT:
      return "Banker bet has lowest house edge at 1.06%.";
    case GameType.THREE_CARD:
      return "Play with Q-6-4 or better. Fold weaker hands.";
    default:
      return "Consider the odds carefully.";
  }
};

/**
 * Basic blackjack strategy without external AI
 */
function getBasicBlackjackAdvice(playerCards: Card[], dealerUpCard: Card | null): string {
  if (!playerCards.length) return "Waiting for cards...";

  // Calculate hand total
  let total = 0;
  let aces = 0;

  for (const card of playerCards) {
    if (card.rank === 'A') {
      aces++;
      total += 11;
    } else if (['J', 'Q', 'K'].includes(card.rank)) {
      total += 10;
    } else {
      total += parseInt(card.rank);
    }
  }

  // Adjust for aces
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  // Basic strategy
  if (total >= 17) return "Stand - strong hand.";
  if (total <= 11) return "Hit - can't bust.";

  if (total >= 12 && total <= 16) {
    if (dealerUpCard) {
      const dealerRank = dealerUpCard.rank;
      if (['2', '3', '4', '5', '6'].includes(dealerRank)) {
        return "Stand - dealer likely to bust.";
      }
    }
    return "Hit - dealer shows strength.";
  }

  return "Consider your options.";
}
