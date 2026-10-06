# Residence and hiring geography

Residence is `data/basics.yaml` country. Remote work is performed from that
country. Citizenship, timezone, employer location, search markets, and
foreign work authorization do not establish residence.

Run `./scripts/geography.py` using the Python launcher convention in
`job-match/references/flows/flow-match.md`. Resolve its path from the loaded
skill, never the profile directory.

Derive geographic membership from the bundled UN M49 map.
Do not maintain or persist candidate region lists or country codes.

Input is `{"country": "Brazil", "places": ["LATAM", "United States"]}`;
`places` defaults to `[]`. Output contains normalized `country`, derived
`regions`, and ordered `matches` (`true`, `false`, or `null` per input place).
No country code is exposed. Unknown country yields `country: null`, empty
regions, and null matches. Invalid input returns `geography_error` and exit 1;
name that error and stop. Missing or unresolved residence stops geographic
matching; run `/job-profile continue fill basics.country`.

Canonical country names, their short forms without a parenthetical, common
English names (Netherlands, South Korea, Russia, Vietnam), and ISO identifiers
resolve ignoring case and accents. A bare two-letter place label matches only
the residence's own code (`US` for a United States residence); any other
two-letter label (`CA`, `CO`, `NA`) may be a state or region abbreviation and
stays unknown. For a United States residence the name Georgia may be the state
and stays unknown.
LATAM / Latin America means the M49 Latin America and the Caribbean group.
Worldwide / anywhere / global includes every resolved residence country.
EU / European Union means the bundled EU member-state group.
Europe also includes every EU member (Cyprus). Europe and Asia stay unknown
for a transcontinental residence M49 files under the other continent
(Russia vs Asia; Georgia, Armenia, Azerbaijan, Kazakhstan, or Türkiye vs Europe).
Unmapped labels, including EMEA / APAC, stay unknown; never guess a map.

Compare only posting evidence describing permitted candidate locations.
Explicit country exclusions override broader included regions.
Unresolved places and missing hiring-location requirements stay unknown.
Remote alone does not establish geographic eligibility.

Pass each printed inclusion and exclusion label separately to the helper.
Any matching explicit exclusion makes the residence incompatible. Otherwise,
any matching inclusion permits the residence unless an exclusion is unknown;
all inclusions resolve false makes it incompatible. Missing inclusions or an
unresolved comparison stays unknown. This is candidate location membership,
not the employer's headquarters or a timezone-overlap requirement. Residence
matching applies to remote hire-from restrictions and explicit residence
requirements; an onsite office address remains a search-market/authorization
question, not evidence of the candidate's present residence.

Geographic membership does not establish work authorization.
Check explicit authorization requirements against `basics.yaml`
`citizenships` and `basics.yaml` `permits`. EOR or contractor acceptance does not
override residence or authorization requirements.

Resolve explicit authorization requirements using
`job-apply/references/contracts/contract-screening.md` **Sponsorship and
authorization** for the asked jurisdiction. A known unmet requirement is
incompatible; a requirement the screening rule leaves unanswered stays unknown. Never infer an
authorization requirement from a remote country label alone.
