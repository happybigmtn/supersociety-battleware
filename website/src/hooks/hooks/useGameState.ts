import { useState, useEffect } from 'react';
import { ChainService, Session } from '../services/chainService';

export function useGameState(sessionId: bigint | undefined) {
    const [session, setSession] = useState<Session | null>(null);

    useEffect(() => {
        if (!sessionId) return;

        const fetch = async () => {
            const s = await ChainService.getSession(sessionId.toString());
            if (s) setSession(s);
        };

        fetch();
        const interval = setInterval(fetch, 1000); // Poll every 1s
        return () => clearInterval(interval);
    }, [sessionId]);

    return session;
}
