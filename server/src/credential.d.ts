export function deriveCredentials(email: string, password: string): Promise<{ credential: string; journalKey: string }>;
