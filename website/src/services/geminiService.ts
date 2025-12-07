import { GoogleGenAI } from "@google/genai";
import { GameType, Card } from '../types';

// Use Vite's environment variable access
const API_KEY = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_KEY || '';
const ai = new GoogleGenAI({ apiKey: API_KEY });

// Helper to format cards for prompt
const formatCards = (cards: Card[]) => cards.map(c => `${c.rank}${c.suit}`).join(',');

export const getStrategicAdvice = async (
  gameType: GameType,
  playerCards: Card[],
  dealerUpCard: Card | null,
  history: string[]
): Promise<string> => {
  if (!API_KEY) return "AI Strategy Offline (No API Key)";

  try {
    const model = "gemini-2.5-flash";
    const prompt = `
      You are a world-class casino expert (Wizard of Odds style).
      Game: ${gameType}.
      My Cards: ${formatCards(playerCards)}.
      ${dealerUpCard ? `Dealer Up Card: ${formatCards([dealerUpCard])}.` : ''}
      Recent History: ${history.slice(-3).join(', ')}.

      Provide a SINGLE SHORT SENTENCE of mathematical advice for the next move.
      Strict format: "ADVICE: [Action] because [Reason]."
      Keep it under 20 words.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
    });

    return response.text.trim();
  } catch (error) {
    console.error("Gemini Error:", error);
    return "Trust your gut.";
  }
};
