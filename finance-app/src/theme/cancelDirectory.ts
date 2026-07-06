// Self-serve cancellation directory. Rocket Money offers concierge cancellation;
// self-hosted, we can't cancel on your behalf, but we can jump you straight to the
// right cancel page. Unknown merchants fall back to a web search.

const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

type CancelEntry = { match: RegExp; url: string };

// Ordered list of common subscriptions → their cancel/manage page.
const DIRECTORY: CancelEntry[] = [
  { match: /netflix/, url: 'https://www.netflix.com/cancelplan' },
  { match: /spotify/, url: 'https://www.spotify.com/account/subscription/' },
  { match: /\bhulu\b/, url: 'https://secure.hulu.com/account' },
  { match: /disney ?\+|disneyplus/, url: 'https://www.disneyplus.com/account/subscription' },
  { match: /\bhbo\b|\bmax\b/, url: 'https://www.max.com/account' },
  { match: /paramount ?\+|paramountplus/, url: 'https://www.paramountplus.com/account/' },
  { match: /peacock/, url: 'https://www.peacocktv.com/account/plans' },
  { match: /apple|itunes/, url: 'https://apps.apple.com/account/subscriptions' },
  { match: /youtube|google (one|storage)|google ?\*/, url: 'https://www.youtube.com/paid_memberships' },
  { match: /amazon prime|prime video|amzn/, url: 'https://www.amazon.com/gp/primecentral' },
  { match: /adobe/, url: 'https://account.adobe.com/plans' },
  { match: /audible/, url: 'https://www.audible.com/account/membership' },
  { match: /nyt|new york times/, url: 'https://www.nytimes.com/subscription/manage' },
  { match: /wall street journal|wsj/, url: 'https://customercenter.wsj.com/' },
  { match: /peloton/, url: 'https://members.onepeloton.com/preferences/subscriptions' },
  { match: /planet fitness/, url: 'https://www.planetfitness.com/account' },
  { match: /la fitness/, url: 'https://www.lafitness.com/Pages/CancellationRequest.aspx' },
  { match: /xbox|game ?pass|microsoft/, url: 'https://account.microsoft.com/services' },
  { match: /playstation|psn|sony/, url: 'https://www.playstation.com/subscriptions' },
  { match: /nintendo/, url: 'https://accounts.nintendo.com/subscription' },
  { match: /dropbox/, url: 'https://www.dropbox.com/account/plan' },
  { match: /icloud/, url: 'https://apps.apple.com/account/subscriptions' },
  { match: /sirius ?xm|siriusxm/, url: 'https://www.siriusxm.com/manage-subscription' },
  { match: /espn ?\+/, url: 'https://plus.espn.com/account' },
  { match: /crunchyroll/, url: 'https://www.crunchyroll.com/account/membership' },
  { match: /twitch/, url: 'https://www.twitch.tv/subscriptions' },
  { match: /patreon/, url: 'https://www.patreon.com/settings/memberships' },
  { match: /openai|chatgpt/, url: 'https://chatgpt.com/#settings/Subscription' },
  { match: /notion/, url: 'https://www.notion.so/my-account' },
  { match: /1password/, url: 'https://my.1password.com/subscription' },
  { match: /grammarly/, url: 'https://account.grammarly.com/subscription' },
  { match: /linkedin/, url: 'https://www.linkedin.com/premium/manage/' },
  { match: /doordash|dashpass/, url: 'https://www.doordash.com/consumer/manage_dashpass/' },
  { match: /uber ?one|uber/, url: 'https://www.uber.com/account/subscriptions' },
  { match: /instacart/, url: 'https://www.instacart.com/store/account/membership' },
  { match: /walmart\+?/, url: 'https://www.walmart.com/plus/manage' },
];

// Returns the best cancel URL for a payee, plus whether we recognized it.
export function cancelInfoFor(payee: string): { url: string; known: boolean } {
  const n = norm(payee);
  for (const e of DIRECTORY) if (e.match.test(n)) return { url: e.url, known: true };
  return { url: `https://www.google.com/search?q=${encodeURIComponent('how to cancel ' + payee + ' subscription')}`, known: false };
}
