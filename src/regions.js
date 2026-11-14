// Where cooks can sell, and the money rules for each currency.
// Each cook picks a country; their Stripe account, menu prices, fees and payouts all use that country's currency.
// Only countries where Stripe Connect Express accounts can take card payments are listed, and only
// currencies with two decimal places (amounts are stored in cents / pence / öre etc.).

// fees: Chefy's pickup and delivery fee. minPrice / maxPrice: allowed dish price. All in minor units.
const CURRENCIES = {
  usd: { pickup: 149, delivery: 399, minPrice: 100, maxPrice: 50000 },
  cad: { pickup: 199, delivery: 499, minPrice: 100, maxPrice: 70000 },
  gbp: { pickup: 119, delivery: 299, minPrice: 100, maxPrice: 40000 },
  eur: { pickup: 139, delivery: 349, minPrice: 100, maxPrice: 45000 },
  chf: { pickup: 139, delivery: 349, minPrice: 100, maxPrice: 45000 },
  aud: { pickup: 229, delivery: 599, minPrice: 100, maxPrice: 75000 },
  nzd: { pickup: 249, delivery: 649, minPrice: 100, maxPrice: 85000 },
  sgd: { pickup: 199, delivery: 499, minPrice: 100, maxPrice: 65000 },
  hkd: { pickup: 1200, delivery: 3000, minPrice: 1000, maxPrice: 400000 },
  sek: { pickup: 1500, delivery: 3900, minPrice: 1000, maxPrice: 500000 },
  nok: { pickup: 1500, delivery: 3900, minPrice: 1000, maxPrice: 500000 },
  dkk: { pickup: 1000, delivery: 2500, minPrice: 1000, maxPrice: 350000 },
  pln: { pickup: 600, delivery: 1500, minPrice: 500, maxPrice: 200000 },
  czk: { pickup: 3500, delivery: 9000, minPrice: 2500, maxPrice: 1200000 },
  ron: { pickup: 700, delivery: 1800, minPrice: 500, maxPrice: 230000 },
  mxn: { pickup: 2500, delivery: 6900, minPrice: 2000, maxPrice: 900000 },
  aed: { pickup: 550, delivery: 1450, minPrice: 500, maxPrice: 180000 },
  myr: { pickup: 650, delivery: 1700, minPrice: 500, maxPrice: 220000 },
  thb: { pickup: 5000, delivery: 13000, minPrice: 4000, maxPrice: 1700000 }
};

const COUNTRIES = {
  US: ['United States', 'usd'], CA: ['Canada', 'cad'], GB: ['United Kingdom', 'gbp'],
  AT: ['Austria', 'eur'], BE: ['Belgium', 'eur'], BG: ['Bulgaria', 'eur'], HR: ['Croatia', 'eur'], CY: ['Cyprus', 'eur'],
  EE: ['Estonia', 'eur'], FI: ['Finland', 'eur'], FR: ['France', 'eur'], DE: ['Germany', 'eur'], GR: ['Greece', 'eur'],
  IE: ['Ireland', 'eur'], IT: ['Italy', 'eur'], LV: ['Latvia', 'eur'], LT: ['Lithuania', 'eur'], LU: ['Luxembourg', 'eur'],
  MT: ['Malta', 'eur'], NL: ['Netherlands', 'eur'], PT: ['Portugal', 'eur'], SK: ['Slovakia', 'eur'], SI: ['Slovenia', 'eur'],
  ES: ['Spain', 'eur'],
  CH: ['Switzerland', 'chf'], SE: ['Sweden', 'sek'], NO: ['Norway', 'nok'], DK: ['Denmark', 'dkk'], PL: ['Poland', 'pln'],
  CZ: ['Czech Republic', 'czk'], RO: ['Romania', 'ron'],
  AU: ['Australia', 'aud'], NZ: ['New Zealand', 'nzd'], SG: ['Singapore', 'sgd'], HK: ['Hong Kong', 'hkd'],
  MY: ['Malaysia', 'myr'], TH: ['Thailand', 'thb'], AE: ['United Arab Emirates', 'aed'], MX: ['Mexico', 'mxn']
};

const DEFAULT_COUNTRY = 'US';

function countryInfo(code) {
  const c = COUNTRIES[code] ? code : DEFAULT_COUNTRY;
  const [name, currency] = COUNTRIES[c];
  return { code: c, name, currency, ...CURRENCIES[currency] };
}
const currencyRules = cur => CURRENCIES[cur] || CURRENCIES.usd;

// What the browser needs: the country list for the setup form and the rules per currency.
function publicRegions() {
  return {
    countries: Object.entries(COUNTRIES).map(([code, [name, currency]]) => ({ code, name, currency }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    currencies: CURRENCIES
  };
}

module.exports = { CURRENCIES, COUNTRIES, DEFAULT_COUNTRY, countryInfo, currencyRules, publicRegions };
