/**
 * US-eligibility gate.
 *
 * On OPT the work has to be in the US. Boards spell locations a dozen ways
 * ("USA - Remote", "Philippines - Manila", "Remote - Americas"), so classify
 * each string and keep the posting if ANY location could be US.
 */

import { norm } from "./normalize.js";

const US_STATES = [
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new hampshire",
  "new jersey",
  "new mexico",
  "new york",
  "north carolina",
  "north dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode island",
  "south carolina",
  "south dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "west virginia",
  "wisconsin",
  "wyoming",
  "district of columbia",
  "washington dc",
  "washington d.c.",
];

const US_ABBR = new Set([
  "al",
  "ak",
  "az",
  "ar",
  "ca",
  "co",
  "ct",
  "de",
  "fl",
  "ga",
  "hi",
  "id",
  "il",
  "in",
  "ia",
  "ks",
  "ky",
  "la",
  "me",
  "md",
  "ma",
  "mi",
  "mn",
  "ms",
  "mo",
  "mt",
  "ne",
  "nv",
  "nh",
  "nj",
  "nm",
  "ny",
  "nc",
  "nd",
  "oh",
  "ok",
  "or",
  "pa",
  "ri",
  "sc",
  "sd",
  "tn",
  "tx",
  "ut",
  "vt",
  "va",
  "wa",
  "wv",
  "wi",
  "wy",
  "dc",
]);

const US_WORDS = [
  "united states",
  "usa",
  "u.s.a",
  "u.s.",
  "us-",
  "us -",
  "nationwide",
];

// "america" is NOT a US token. It matches "Latin America", "South America" and
// "Central America" — a Sezzle role listing ["Mexico, Remote", "Bogota,
// Colombia", "Latin America [Remote]", "Turkey"] resolved to eligible because
// three correct non-US verdicts were overridden by one false "us". Multi-
// location matching is any-eligible by design, so a single false positive
// decides the whole posting.
//
// The compound forms that DO imply the US are matched explicitly, and the
// Latin/South/Central qualifiers are rejected before they can be reached.
const AMERICA_NON_US = /\b(latin|south|central)\s+america/i;
const AMERICA_US = /\b(north\s+america|americas?)\b/i;

const US_CITIES = [
  "san francisco",
  "new york",
  "nyc",
  "seattle",
  "austin",
  "boston",
  "chicago",
  "denver",
  "los angeles",
  "san jose",
  "palo alto",
  "mountain view",
  "sunnyvale",
  "menlo park",
  "cupertino",
  "redmond",
  "bellevue",
  "atlanta",
  "dallas",
  "houston",
  "phoenix",
  "tempe",
  "scottsdale",
  "chandler",
  "mesa",
  "san diego",
  "portland",
  "miami",
  "philadelphia",
  "pittsburgh",
  "detroit",
  "minneapolis",
  "salt lake city",
  "raleigh",
  "durham",
  "charlotte",
  "nashville",
  "columbus",
  "boulder",
  "irvine",
  "santa clara",
  "santa monica",
  "arlington",
  "cambridge",
  "brooklyn",
  "jersey city",
  "hoboken",
  "reston",
  "mclean",
];

// If one of these appears and nothing US does, the posting is out.

// Every sovereign country except the United States, plus common short forms.
// Enumerated rather than curated: a hand-maintained list is whack-a-mole, and
// this file had already been patched for India, then Iceland, then Serbia and
// Stuttgart, each found by a human reading a posting that had been scored as
// applicable. Countries are a closed set, so close it.
//
// Multi-word names are stored WHOLE. An earlier version built this list by
// splitting on whitespace, which turned "south africa" into the bare token
// "south" and classified "600 Boulevard South, Huntsville, AL 35802" as
// non-US. Matching is phrase-based via hasWord, so entries must be phrases.
const WORLD_NON_US_LIST = [
  "afghanistan","albania","algeria","andorra","angola","argentina","armenia","australia",
  "austria","azerbaijan","bahamas","bahrain","bangladesh","barbados","belarus","belgium",
  "belize","benin","bhutan","bolivia","botswana","brazil","brunei","bulgaria","burundi",
  "cambodia","cameroon","canada","chad","chile","china","colombia","comoros","congo",
  "croatia","cuba","cyprus","czechia","denmark","djibouti","dominica","ecuador","egypt",
  "eritrea","estonia","eswatini","ethiopia","fiji","finland","france","gabon","gambia",
  "germany","ghana","greece","grenada","guatemala","guinea","guyana","haiti","honduras",
  "hungary","iceland","india","indonesia","iran","iraq","ireland","israel","italy",
  "jamaica","japan","jordan","kazakhstan","kenya","kiribati","kosovo","kuwait","kyrgyzstan",
  "laos","latvia","lebanon","lesotho","liberia","libya","liechtenstein","lithuania",
  "luxembourg","madagascar","malawi","malaysia","maldives","mali","malta","mauritania",
  "mauritius","mexico","moldova","monaco","mongolia","montenegro","morocco","mozambique",
  "myanmar","namibia","nepal","netherlands","nicaragua","niger","nigeria","norway","oman",
  "pakistan","panama","paraguay","peru","philippines","poland","portugal","qatar","romania",
  "russia","rwanda","senegal","serbia","seychelles","singapore","slovakia","slovenia",
  "somalia","spain","sudan","suriname","sweden","switzerland","syria","taiwan","tajikistan",
  "tanzania","thailand","togo","tonga","tunisia","turkey","turkmenistan","uganda","ukraine",
  "uruguay","uzbekistan","vanuatu","venezuela","vietnam","yemen","zambia","zimbabwe",
  // multi-word, kept whole
  "united arab emirates","united kingdom","dominican republic","papua new guinea",
  "equatorial guinea","burkina faso","cape verde","costa rica","czech republic",
  "el salvador","new zealand","north macedonia","san marino","saudi arabia","sierra leone",
  "south africa","south korea","south sudan","sri lanka","trinidad and tobago",
  "bosnia and herzegovina","ivory coast","great britain","northern ireland",
  // short forms and constituent nations
  "scotland","wales","england","britain","holland","uae",
];

const NON_US = [
  // Bare city names. A location like "Reykjavík" carries no country token and
  // no ISO code, so without an entry here it resolves to "unknown" and fails
  // open — which is how an Asana role in Iceland reached manual scoring.
  // Bare foreign city names. Countries are a closed set and handled below;
  // cities are not, so this stays curated. Cape Town and One-north (Singapore)
  // were previously caught only by accident, via the stray "cape" and "north"
  // tokens the broken split produced.
  "cape town",
  "johannesburg",
  "one-north",
  "reykjavik",
  "reykjavík",
  "oslo",
  "helsinki",
  "copenhagen",
  "stockholm",
  "gothenburg",
  "tallinn",
  "riga",
  "vilnius",
  "gdansk",
  "gdańsk",
  "wroclaw",
  "wrocław",
  "poznan",
  "krakow",
  "kraków",
  "brno",
  "cluj",
  "haifa",
  "herzliya",
  "icheon",
  "hiroshima",
  "india",
  "philippines",
  "israel",
  "united kingdom",
  "uk",
  "london",
  "germany",
  "berlin",
  "munich",
  "düsseldorf",
  "dusseldorf",
  "france",
  "paris",
  "netherlands",
  "amsterdam",
  "alkmaar",
  "spain",
  "madrid",
  "barcelona",
  "italy",
  "poland",
  "krakow",
  "warsaw",
  "romania",
  "bucharest",
  "portugal",
  "lisbon",
  "ireland",
  "dublin",
  "sweden",
  "stockholm",
  "norway",
  "denmark",
  "copenhagen",
  "finland",
  "helsinki",
  "switzerland",
  "zurich",
  "austria",
  "vienna",
  "belgium",
  "brussels",
  "czech",
  "prague",
  "hungary",
  "budapest",
  "greece",
  "athens",
  "turkey",
  "istanbul",
  "ukraine",
  "kyiv",
  "bulgaria",
  "sofia",
  "canada",
  "toronto",
  "vancouver",
  "montreal",
  "ottawa",
  "waterloo",
  "mexico",
  "guadalajara",
  "brazil",
  "sao paulo",
  "são paulo",
  "argentina",
  "colombia",
  "bogota",
  "chile",
  "santiago",
  "peru",
  "costa rica",
  "uruguay",
  "australia",
  "sydney",
  "melbourne",
  "new zealand",
  "auckland",
  "japan",
  "tokyo",
  "china",
  "beijing",
  "shanghai",
  "shenzhen",
  "hong kong",
  "taiwan",
  "singapore",
  "korea",
  "seoul",
  "malaysia",
  "kuala lumpur",
  "indonesia",
  "jakarta",
  "vietnam",
  "hanoi",
  "thailand",
  "bangkok",
  "pakistan",
  "bangladesh",
  "egypt",
  "cairo",
  "south africa",
  "nigeria",
  "kenya",
  "morocco",
  "uae",
  "dubai",
  "abu dhabi",
  "saudi",
  "riyadh",
  "qatar",
  "doha",
  "pune",
  "bangalore",
  "bengaluru",
  "hyderabad",
  "chennai",
  "mumbai",
  "delhi",
  "gurgaon",
  "noida",
  "kolkata",
  "ahmedabad",
  "manila",
  "cebu",
  "raanana",
  "tel aviv",
  "herzliya",
  "emea",
  "apac",
  "latam",
  "anz",
];

// ISO country codes. Many collide with US state codes — CA is both California
// and Canada, IN is Indiana and India, IL is Illinois and Israel, DE is Delaware
// and Germany. Position disambiguates: in "City, Region, XX" the trailing token
// is a COUNTRY; in "City, XX" it is a US state.
const NON_US_COUNTRY_CODES = new Set([
  "ca","in","il","de","gb","uk","fr","ie","au","nz","jp","cn","kr","sg","my","ph",
  "id","vn","th","br","mx","ar","cl","co","pe","za","ng","ke","eg","ae","sa","qa",
  "pl","ro","pt","es","it","nl","be","se","no","dk","fi","ch","at","cz","hu","gr",
  "tr","ua","bg","hr","rs","lt","lv","ee","is","lu","mt","cy","tw","hk","pk","bd",
  "lk","np","ma","tn","gh","cr","uy","py","bo","ec","ve","pa","do","gt","jm","tt",
]);
// Three-letter ISO codes. Amazon's board emits these ("Asti, Piedmont, ITA"),
// and because ISO-3 collides with nothing in the US state list there is no
// positional ambiguity to resolve — a trailing ITA is always Italy.
//
// Their absence was not a near-miss. Both parts of that location resolved to
// "unknown", and unknown fails open to eligible, so a role in Piedmont was
// presented as applicable. Fail-open is right for genuinely ambiguous input;
// it is wrong when the input was unambiguous and merely unparsed.
const NON_US_COUNTRY_CODES_3 = new Set([
  "ita","deu","fra","esp","prt","nld","bel","che","aut","swe","nor","dnk","fin",
  "pol","rou","cze","hun","grc","irl","gbr","isl","lux","hrv","srb","bgr","ukr",
  "ltu","lva","est","mlt","cyp","tur","rus","ind","chn","jpn","kor","sgp","mys",
  "phl","idn","vnm","tha","twn","hkg","pak","bgd","lka","npl","aus","nzl","can",
  "mex","bra","arg","chl","col","per","ury","pry","bol","ecu","ven","cri","pan",
  "dom","gtm","jam","tto","zaf","nga","ken","egy","mar","tun","gha","are","sau",
  "qat","isr","jor","lbn",
]);
const US_COUNTRY_CODES = new Set(["us","usa","u.s.","u.s.a.","usa.","united states"]);

const REMOTE_HINT =
  /\bremote\b|\bwork from home\b|\bwfh\b|\banywhere\b|\bdistributed\b/i;

function hasWord(text, word) {
  const w = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![a-z0-9])${w}(?![a-z0-9])`, "i").test(text);
}

/**
 * 'us' | 'non_us' | 'remote_unknown' | 'unknown'
 *
 * Structure is read before keywords, because keyword scanning cannot resolve
 * the state/country code collision. "Vancouver, BC, CA" and "Mountain View, CA,
 * US" both contain "CA"; only position tells them apart.
 */
export function classifyLocation(raw = "") {
  const t = norm(raw);
  if (!t) return "unknown";

  // --- structural pass: trailing token of a comma-delimited location ---
  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1].replace(/\./g, "");
    // Amazon writes the country FIRST: "US, WA, Seattle", "GB, Cambridge",
    // "TW, TPE, Taipei". The positional rule below expects it last, so those
    // international reqs fell through to unknown and failed open.
    //
    // Only trusted when the leading token cannot also be a US state code. CA,
    // IN, IL and friends are left to the existing logic rather than guessed at.
    const first = parts[0];
    if (first && first.length === 2 && !US_ABBR.has(first)) {
      if (US_COUNTRY_CODES.has(first)) return "us";
      if (NON_US_COUNTRY_CODES.has(first)) return "non_us";
    }

    if (US_COUNTRY_CODES.has(last)) return "us";
    if (NON_US_COUNTRY_CODES_3.has(last)) return "non_us";
    if (parts.length >= 3) {
      // 3+ parts => trailing token is a country, never a US state
      if (NON_US_COUNTRY_CODES.has(last)) return "non_us";
      if (NON_US_COUNTRY_CODES_3.has(last)) return "non_us";
    } else {
      // Exactly 2 parts is genuinely ambiguous when the code is both a US state
      // and a country: "Berlin, DE" is Germany, "Wilmington, DE" is Delaware.
      // The city decides — check it against the non-US list before assuming a
      // state code.
      const city = parts[0];
      const cityIsNonUs = NON_US.some((n) => hasWord(city, n));
      if (cityIsNonUs) return "non_us";
      if (US_ABBR.has(last)) return "us";
      if (NON_US_COUNTRY_CODES.has(last)) return "non_us";
      if (NON_US_COUNTRY_CODES_3.has(last)) return "non_us";
    }
  }

  // --- keyword pass ---
  let us = false;
  for (const w of US_WORDS) if (t.includes(w)) { us = true; break; }
  // Latin/South/Central America must be rejected before any "americas" match.
  if (AMERICA_NON_US.test(t)) return "non_us";
  if (!us && AMERICA_US.test(t)) us = true;

  // "Huntsville, AL 35802" — a two-letter state beside a five-digit ZIP is an
  // unambiguous US address, and the positional parser misses it on long street
  // strings where the trailing token is "AL 35802" rather than a country.
  if (!us && /\b[a-z]{2}\s+\d{5}(?:-\d{4})?\b/i.test(t)) us = true;

  if (!us) for (const st of US_STATES) if (hasWord(t, st)) { us = true; break; }
  if (!us) for (const c of US_CITIES) if (hasWord(t, c)) { us = true; break; }

  let nonUs = false;
  for (const n of NON_US) if (hasWord(t, n)) { nonUs = true; break; }
  // Closed-set country check. Runs after the curated list so the specific
  // city entries above still win, and after the US checks so "Georgia" the
  // US state is not read as Georgia the country.
  if (!nonUs && !us)
    for (const n of WORLD_NON_US_LIST) if (hasWord(t, n)) { nonUs = true; break; }

  // A non-US signal outranks a bare US city name: "London - remote first in EU"
  // must not pass because a two-letter fragment looked like a state code. The
  // free-text 2-letter state scan is gone entirely for this reason — it matched
  // "in" inside "first in EU".
  if (nonUs) return "non_us";
  if (us) return "us";
  if (REMOTE_HINT.test(t)) return "remote_unknown";
  return "unknown";
}

/**
 * Verdict across all of a posting's locations.
 * Keeps anything that could be US; rejects only when every location is clearly not.
 */
export function locationVerdict(locations = []) {
  const list = (Array.isArray(locations) ? locations : [locations]).filter(
    Boolean,
  );
  if (!list.length) return { eligible: true, reason: "no_location", kinds: [] };

  const kinds = list.map(classifyLocation);
  const hasUs = kinds.includes("us");
  const hasNonUs = kinds.includes("non_us");

  // An explicit US location always wins, even on a multi-region listing.
  if (hasUs) return { eligible: true, reason: "us", kinds };

  // A bare "Remote" is only ambiguous when nothing anchors the role to another
  // country. Boards routinely emit ["Zurich, Switzerland", "Remote"], where the
  // Remote tag means remote-in-Switzerland — not remote-from-anywhere.
  if (hasNonUs) return { eligible: false, reason: "all_non_us", kinds };

  if (kinds.includes("remote_unknown"))
    return { eligible: true, reason: "remote_unknown", kinds };
  if (kinds.includes("unknown"))
    return { eligible: true, reason: "unknown", kinds };

  return { eligible: false, reason: "all_non_us", kinds };
}

/** Phoenix-metro flag — local roles are worth surfacing separately. */
const PHX = [
  "phoenix",
  "tempe",
  "scottsdale",
  "chandler",
  "mesa",
  "gilbert",
  "glendale",
  "peoria",
  "arizona",
];
export function isPhoenixMetro(locations = []) {
  const t = norm(
    (Array.isArray(locations) ? locations : [locations]).join(" | "),
  );
  return PHX.some((c) => hasWord(t, c));
}


/**
 * Body-level location override.
 *
 * Structured location fields lie by omission. A Lever posting whose
 * `categories.location` is just "Remote" can say "This is a Remote based
 * position in India" in the first line of the description — and "Remote" is
 * classified ambiguous-but-eligible, so it passes. That is not hypothetical:
 * it is how a Bangalore role reached the approved queue with a fit of 85.
 *
 * Only consulted when the structured verdict is NOT already 'us'. A US-tagged
 * posting that merely mentions another country ("our Berlin office") must not
 * be rejected by a stray keyword.
 */
const REMOTE_COUNTRY_RE =
  /\b(?:remote|based|position|role|located|hiring|work)\b[^.]{0,60}?\bin\s+(?:the\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/g;

export function locationFromBody(description = "") {
  if (!description) return null;
  const head = String(description).slice(0, 1200);

  // Explicit "in <Country>" phrasing near a placement word.
  REMOTE_COUNTRY_RE.lastIndex = 0;
  let m;
  while ((m = REMOTE_COUNTRY_RE.exec(head)) !== null) {
    const kind = classifyLocation(m[1]);
    if (kind === "non_us") return { kind, evidence: m[0].trim().slice(0, 90) };
    if (kind === "us") return { kind, evidence: m[0].trim().slice(0, 90) };
  }
  return null;
}

/**
 * Final verdict combining structured locations with the body.
 * The body only ever *tightens* the result — it can reject an ambiguous
 * posting, never rescue a clearly non-US one.
 */
export function locationVerdictWithBody(locations = [], description = "") {
  const base = locationVerdict(locations);
  if (base.reason === "us") return base;

  const body = locationFromBody(description);
  if (body?.kind === "non_us") {
    return { ...base, eligible: false, reason: "body_non_us", bodyEvidence: body.evidence };
  }
  if (body?.kind === "us" && !base.eligible) {
    return { ...base, eligible: true, reason: "body_us", bodyEvidence: body.evidence };
  }
  return base;
}
