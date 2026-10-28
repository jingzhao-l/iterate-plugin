/** Locale-owned sandbox approval text; audit inputs remain verbatim. */
/** English escalation messages. */
export declare const en: {
    escalation: (mode: string, justification: string) => string;
};
/** Chinese escalation messages. */
export declare const zh: {
    escalation: (mode: string, justification: string) => string;
};
/** Japanese escalation messages. */
export declare const ja: {
    escalation: (mode: string, justification: string) => string;
};
/** Spanish dictionary, checked against the English keys. */
export declare const es: {
    escalation: (mode: string, justification: string) => string;
};
/** French dictionary, checked against the English keys. */
export declare const fr: {
    escalation: (mode: string, justification: string) => string;
};
/** German dictionary, checked against the English keys. */
export declare const de: {
    escalation: (mode: string, justification: string) => string;
};
/** Russian dictionary, checked against the English keys. */
export declare const ru: {
    escalation: (mode: string, justification: string) => string;
};
/** Portuguese dictionary, checked against the English keys. */
export declare const pt: {
    escalation: (mode: string, justification: string) => string;
};
/**
 * Build translations for the existing Client localized-text resolver.
 * @param mode - requested sandbox mode.
 * @param justification - raw model justification, preserved in every translation.
 * @returns localized approval text.
 */
export declare function escalationDisplayReason(mode: string, justification: string): Record<'en' | 'zh' | 'ja' | 'es' | 'fr' | 'de' | 'ru' | 'pt', string>;
//# sourceMappingURL=locales.d.ts.map