import { SymbolViewProps } from 'expo-symbols';

export type CatIcon = { symbol: SymbolViewProps['name']; color: string };

// Keyword → icon/color. Checked in order against the category (or merchant) name,
// so the most specific patterns come first. Gives every row a Rocket-Money-style
// glyph without any network/logo lookups.
const RULES: [RegExp, CatIcon][] = [
  [/coffee|cafe|starbucks|dunkin|tea\b/i, { symbol: 'cup.and.saucer.fill', color: '#f59e0b' }],
  [/grocer|market|costco|kroger|trader|whole\s?foods|aldi|safeway|meijer|food\b/i, { symbol: 'cart.fill', color: '#22c55e' }],
  [/restaurant|dining|dine|eat|pizza|taco|burger|mcdonald|chipotle|doordash|uber\s?eats|grubhub|food/i, { symbol: 'fork.knife', color: '#f97316' }],
  [/gas|fuel|shell|chevron|exxon|mobil|\bbp\b|marathon|speedway|station/i, { symbol: 'fuelpump.fill', color: '#eab308' }],
  [/uber|lyft|transit|transport|train|metro|subway\stransit|parking|toll|rideshare/i, { symbol: 'car.fill', color: '#06b6d4' }],
  [/rent|mortgage|housing|landlord|apartment|\bhoa\b/i, { symbol: 'house.fill', color: '#7c6ef7' }],
  [/electric|utility|utilities|\bwater\b|\bdte\b|energy|\bpower\b|gas\s?&\s?electric/i, { symbol: 'bolt.fill', color: '#eab308' }],
  [/internet|wifi|comcast|xfinity|spectrum|fiber|broadband/i, { symbol: 'wifi', color: '#06b6d4' }],
  [/phone|mobile|at&t|verizon|t-mobile|cellular|sprint/i, { symbol: 'phone.fill', color: '#06b6d4' }],
  [/gym|fitness|crunch|planet\sfitness|peloton|workout|\byoga\b/i, { symbol: 'dumbbell.fill', color: '#ef4444' }],
  [/health|medical|doctor|pharmacy|\bcvs\b|walgreens|dental|clinic|hospital/i, { symbol: 'cross.case.fill', color: '#ef4444' }],
  [/netflix|spotify|hulu|disney|\bhbo\b|youtube|prime\svideo|max\b|paramount|peacock|stream|music/i, { symbol: 'play.rectangle.fill', color: '#ec4899' }],
  [/amazon|target|walmart|\bbest\sbuy\b|store|cloth|apparel|retail|shopping|shop\b/i, { symbol: 'bag.fill', color: '#a898ff' }],
  [/travel|hotel|airbnb|flight|airline|delta|united|expedia|booking|vrbo|resort/i, { symbol: 'airplane', color: '#3b82f6' }],
  [/insurance|geico|allstate|progressive|state\sfarm/i, { symbol: 'shield.lefthalf.filled', color: '#14b8a6' }],
  [/transfer|venmo|zelle|paypal|cash\s?app|wire|\bach\b/i, { symbol: 'arrow.left.arrow.right', color: '#6b6b80' }],
  [/income|salary|payroll|paycheck|direct\sdep|deposit|interest|dividend|refund/i, { symbol: 'dollarsign.circle.fill', color: '#22c55e' }],
  [/cloud|software|\baws\b|vultr|github|hosting|saas|adobe|notion|\bapi\b/i, { symbol: 'cloud.fill', color: '#a898ff' }],
  [/subscription|membership|recurring/i, { symbol: 'repeat', color: '#a898ff' }],
  [/education|tuition|school|college|university|textbook|student|\bbook\b/i, { symbol: 'graduationcap.fill', color: '#6366f1' }],
  [/\bpet\b|\bvet\b|chewy|petco|petsmart/i, { symbol: 'pawprint.fill', color: '#f59e0b' }],
  [/saving|invest|brokerage|fidelity|vanguard|robinhood|schwab|crypto|coinbase|\b401k\b/i, { symbol: 'chart.line.uptrend.xyaxis', color: '#10b981' }],
  [/gift|charit|donat|fundrais/i, { symbol: 'gift.fill', color: '#f43f5e' }],
  [/cash|\batm\b|withdraw/i, { symbol: 'banknote.fill', color: '#22c55e' }],
  [/beauty|salon|barber|haircut|nails|spa\b/i, { symbol: 'scissors', color: '#ec4899' }],
  [/home\s?improv|hardware|repair|maintenance|home\sdepot|lowe|furniture|\bikea\b/i, { symbol: 'wrench.and.screwdriver.fill', color: '#f97316' }],
  [/entertain|movie|cinema|game|steam|playstation|xbox|nintendo|concert|ticket/i, { symbol: 'gamecontroller.fill', color: '#ec4899' }],
  [/fee|charge|service\scharge|bank\sfee|interest\scharge/i, { symbol: 'building.columns.fill', color: '#6b6b80' }],
  [/tax|\birs\b/i, { symbol: 'doc.text.fill', color: '#6b6b80' }],
];

const DEFAULT: CatIcon = { symbol: 'creditcard.fill', color: '#8b8ba0' };

export function categoryIcon(name?: string): CatIcon {
  const s = name || '';
  for (const [re, icon] of RULES) if (re.test(s)) return icon;
  return DEFAULT;
}

// Stable, well-distributed color for a merchant monogram derived from its name.
const MONO = ['#7c6ef7', '#a898ff', '#22c55e', '#06b6d4', '#f97316', '#ec4899', '#8b5cf6', '#14b8a6', '#f59e0b', '#6366f1', '#10b981', '#3b82f6'];
export function monogramColor(label?: string): string {
  const s = (label || '?').trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return MONO[h % MONO.length];
}
