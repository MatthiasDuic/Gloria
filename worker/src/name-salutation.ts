export type Gender = "male" | "female";

// Common first names in Germany; unisex names (Alex, Kim, Robin, Sascha, Chris, ...) are intentionally missing.
const MALE_FIRST_NAMES = new Set(`
achim adam adrian ahmed alexander alfred ali andreas andré andre angelo anton armin arne arno arnold arthur artur axel
benedikt benjamin bernd bernhard björn bjoern bodo boris bruno burkhard carl carsten christian christoph christopher claus
clemens constantin daniel david denis dennis detlef detlev diego dieter dietmar dimitri dirk dominik edgar eduard egon
elias emil enrico erhard eric erich erik ernst erwin eugen fabian falk felix ferdinand florian frank franz frederik fred
friedrich fritz georg gerald gerd gerhard gerrit gregor guido gunnar günter günther guenter gustav hagen hannes hans harald
harry hartmut hasan heiko heinrich heinz helge helmut hendrik henning henrik herbert hermann holger horst hubert hugo
ibrahim igor ingo jakob jan jannik jens jeremias jochen joachim johann johannes jonas jonathan jörg joerg josef joseph
julian julius jürgen juergen justus kai karl karsten kevin klaus konrad konstantin kurt lars laurenz leon leonard leopold
lothar louis ludwig lukas lutz malte manfred manuel marc marcel marco marcus mario marius mark markus martin mathias
matthias max maximilian mehmet michael mike milan mirko moritz murat mustafa nico niklas niko nikolai nikolaus nils
norbert norman olaf oliver oskar otto patrick paul peter philipp pierre rainer ralf ralph raphael reiner reinhard reinhold
rené rene richard robert roland rolf roman ronald rüdiger ruediger rudolf rudi samuel sebastian siegfried simon stefan
steffen stephan sven theo theodor thilo thomas thorsten thomas till tilo tim timo tobias tom torsten udo ulf ulrich uwe
valentin viktor vincent volker walter werner wilfried wilhelm willi winfried wolf wolfgang yannick yusuf
`.split(/\s+/).filter(Boolean));

const FEMALE_FIRST_NAMES = new Set(`
agnes alexandra alice alina alexa amelie ana andrea angela angelika anita anja anke anna annalena anne annegret anneliese
annette antje antonia astrid ayse barbara beate bettina bianca birgit brigitte britta carina carla carmen carolin caroline
charlotte christa christel christiane christina christine claudia clara cornelia dagmar daniela denise diana doris dorothea
edith elena elfriede elisabeth elke ella ellen elke emilia emily emma erika esther eva evelyn fatma franziska frauke
friederike gabi gabriele gerda gertrud gisela gudrun hanna hannah hannelore heidi heike helena helene helga henriette hildegard
ilona ilse ina ines inga inge ingrid irene iris isabel isabell isabella jacqueline jana janina jasmin jennifer jessica johanna
josephine judith julia juliane jutta karin karina katarina katharina kathrin katja katrin kerstin kirsten klara korinna
kristin larissa laura lea lena leonie liane lina linda lisa lotte luisa luise madeleine maike manuela mareike margarete
margit maria marianne marie marina marion marlene martina maren melanie meike michaela miriam monika nadine nadja natalie
nathalie nicole nina nora olga patricia paula petra pia ramona rebecca rebekka regina renate ricarda rita rosemarie ruth
sabine sabrina sandra sara sarah silke silvia simone sofia sonja sophia sophie stefanie stephanie susanne svenja swantje
sylvia tamara tanja tatjana theresa therese tina ulrike ursula ute valentina vanessa vera verena veronika viktoria waltraud
wiebke yvonne
`.split(/\s+/).filter(Boolean));

const TITLE_PATTERN = /^(?:(?:dr|prof|dipl|ing)\.?(?:-\w+\.?)?\s+)+/i;

/** Guesses the gender from the first given name; undefined for unknown or unisex names. */
export function detectGenderFromName(fullName: string | undefined): Gender | undefined {
  const name = fullName?.replace(/\s+/g, " ").trim().replace(TITLE_PATTERN, "") || "";
  const parts = name.split(" ");
  if (parts.length < 2) return undefined;
  const first = parts[0].split("-")[0].toLowerCase().normalize("NFC");
  if (MALE_FIRST_NAMES.has(first)) return "male";
  if (FEMALE_FIRST_NAMES.has(first)) return "female";
  return undefined;
}

/**
 * Dative form for "mit …" / "von …": "Herrn Martin Müller" or "Frau Petra Schulz".
 * An existing salutation wins; unknown or unisex first names stay without salutation unless a fallback is given.
 */
export function addressPersonDative(fullName: string, fallback?: Gender): string {
  const name = fullName.replace(/\s+/g, " ").trim();
  if (/^frau\s/i.test(name)) return name.replace(/^frau\s/i, "Frau ");
  if (/^herrn?\s/i.test(name)) return name.replace(/^herrn?\s/i, "Herrn ");
  const gender = detectGenderFromName(name) || fallback;
  if (gender === "male") return `Herrn ${name}`;
  if (gender === "female") return `Frau ${name}`;
  return name;
}
