/**
 * Currency conversion service
 * Fetches real-time exchange rates and converts foreign currencies to INR
 */

interface ExchangeRates {
  [currency: string]: number; // Rate to convert 1 unit of currency to INR
}

// Cache for exchange rates (refresh every hour)
let cachedRates: ExchangeRates | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

// Fallback rates in case API fails
const FALLBACK_RATES: ExchangeRates = {
  INR: 1,
  USD: 83,
  EUR: 90,
  GBP: 105,
  AED: 22.6,
  SGD: 62,
  JPY: 0.55,
  CAD: 61,
  AUD: 54,
};

/**
 * Fetch exchange rates from a free API
 * Using exchangerate-api.com free tier (1500 requests/month)
 */
async function fetchExchangeRates(): Promise<ExchangeRates> {
  try {
    // Free API - no key needed for basic usage
    const response = await fetch(
      "https://api.exchangerate-api.com/v4/latest/INR"
    );

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = (await response.json()) as { rates: Record<string, number> };

    // API returns rates FROM INR, we need TO INR
    // So we invert: 1/rate gives us how many INR per 1 unit of foreign currency
    const rates: ExchangeRates = { INR: 1 };

    for (const [currency, rate] of Object.entries(data.rates)) {
      if (typeof rate === "number" && rate > 0) {
        rates[currency] = 1 / rate;
      }
    }

    console.log(
      `[Currency] Fetched rates - USD: ${rates.USD?.toFixed(2)}, EUR: ${rates.EUR?.toFixed(2)}`
    );
    return rates;
  } catch (error) {
    console.warn("[Currency] Failed to fetch rates, using fallback:", error);
    return FALLBACK_RATES;
  }
}

/**
 * Get exchange rates (cached)
 */
async function getExchangeRates(): Promise<ExchangeRates> {
  const now = Date.now();

  if (cachedRates && now - cacheTimestamp < CACHE_DURATION_MS) {
    return cachedRates;
  }

  cachedRates = await fetchExchangeRates();
  cacheTimestamp = now;
  return cachedRates;
}

/**
 * Convert an amount from a foreign currency to INR
 */
export async function convertToINR(
  amount: number,
  currency: string
): Promise<{ amountINR: number; rate: number }> {
  const currencyUpper = currency.toUpperCase();

  if (currencyUpper === "INR") {
    return { amountINR: amount, rate: 1 };
  }

  const rates = await getExchangeRates();
  const rate = rates[currencyUpper] || FALLBACK_RATES[currencyUpper];

  if (!rate) {
    console.warn(
      `[Currency] Unknown currency: ${currency}, using 1:1 conversion`
    );
    return { amountINR: amount, rate: 1 };
  }

  const amountINR = Math.round(amount * rate * 100) / 100; // Round to 2 decimal places
  return { amountINR, rate };
}

/**
 * Check if a currency is foreign (not INR)
 */
export function isForeignCurrency(currency: string | null | undefined): boolean {
  if (!currency) return false;
  return currency.toUpperCase() !== "INR";
}
