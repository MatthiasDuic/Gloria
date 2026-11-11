export type Gender = "male" | "female";

// Common first names in Germany; unisex names live in AMBIGUOUS_FIRST_NAMES.
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
agnes alexandra alice alina alexa amelie ana angela angelika anita anja anke anna annalena anne annegret anneliese
annette antje antonia astrid ayse barbara beate bettina bianca birgit brigitte britta carina carla carmen carolin caroline
charlotte christa christel christiane christina christine claudia clara cornelia dagmar daniela denise diana doris dorothea
edith elena elfriede elisabeth elke ella ellen elke emilia emily emma erika esther eva evelyn fatma franziska frauke
friederike gabi gerda gertrud gisela gudrun hanna hannah hannelore heidi heike helena helene helga henriette hildegard
ilona ilse ina ines inga inge ingrid irene iris isabel isabell isabella jacqueline jana janina jennifer jessica johanna
josephine judith julia juliane jutta karin karina katarina katharina kathrin katja katrin kerstin kirsten klara korinna
kristin larissa laura lea lena leonie liane lina linda lisa lotte luisa luise madeleine maike manuela mareike margarete
margit maria marianne marie marina marion marlene martina maren melanie meike michaela miriam monika nadine nadja natalie
nathalie nicole nina nora olga patricia paula petra pia ramona rebecca rebekka regina renate ricarda rita rosemarie ruth
sabine sabrina sandra sara sarah silke silvia sofia sonja sophia sophie stefanie stephanie susanne svenja swantje
sylvia tamara tanja tatjana theresa therese tina ulrike ursula ute valentina vanessa vera verena veronika viktoria waltraud
wiebke yvonne
`.split(/\s+/).filter(Boolean));

// Common first names from other European countries, grouped by language.
const EUROPEAN_MALE_FIRST_NAMES = `
alessandro alessio alberto aldo antonio carlo claudio corrado cristiano dario davide domenico emanuele enzo fabio
fabrizio federico filippo francesco franco gianluca gianni giacomo giorgio giovanni giulio giuseppe giancarlo gianfranco
lorenzo luca luciano luigi marcello massimo matteo maurizio mauro nicolò niccolò paolo pasquale piero pietro raffaele
renato riccardo roberto rocco salvatore sergio silvio stefano tommaso umberto valerio vincenzo vittorio
alejandro alfonso álvaro andrés carlos cristian eduardo emilio enrique esteban fernando francisco gonzalo guillermo
ignacio jaime javier jesús joaquín jorge josé juan luis miguel nicolás pablo pedro rafael ramón ricardo rodrigo rubén
raúl salvador santiago tomás víctor joão paulo rui nuno tiago thiago gonçalo vasco duarte
alain antoine arnaud baptiste benoît bertrand christophe cédric damien didier emmanuel étienne fabrice françois
frédéric gérard gilles grégoire guillaume hervé jacques jean jérôme julien laurent lionel loïc luc lucas mathieu
matthieu maxime nicolas pascal quentin rémi renaud romain sébastien stéphane sylvain thierry xavier yves
bram bas daan floris freek henk jaap jeroen joost joris koen kees luuk maarten martijn niels pieter rob roel ruud
sander stijn teun thijs wim wouter
anders bengt bjørn espen fredrik håkan johan kjell knut magnus mats mikael morten ola olav ole per rasmus søren stig
thor tor torben antti jari juha jukka kari markku matti mikko pekka
andrzej bartosz dariusz grzegorz jacek jakub janusz jarosław jerzy kamil karol krzysztof łukasz maciej marcin marek
mariusz mateusz michał mirosław paweł piotr przemysław radosław rafał ryszard sławomir stanisław szymon tadeusz tomasz
wiesław witold wojciech zbigniew jiří jaroslav karel ladislav lubomír miroslav ondřej pavel petr radek stanislav
václav vojtěch zdeněk
aleksandar ante branko darko davor dejan dragan dražen dušan goran hrvoje ivan ivica josip kristijan luka marko
miloš mladen nebojša nenad nikola predrag saša slobodan srđan stjepan tomislav vladimir zlatko zoran željko edin emir
haris adnan amir damir dino elvir mirza
alexandros christos dimitrios dimitris georgios giorgos ioannis konstantinos kostas michalis nikolaos nikos
panagiotis petros spyros stavros theodoros vasilis vasileios yannis giannis athanasios evangelos
alexandru andrei bogdan cătălin claudiu dan doru florin gabriel gheorghe ion ionuț iulian lucian mihai mircea nicolae
ovidiu radu sorin ștefan vasile viorel
aleksandr aleksej alexej andrej anatolij dmitri dmitrij jewgeni juri jurij maxim michail oleg sergej sergei vitali
waldemar wladimir artem
attila balázs csaba gábor istván józsef lászló sándor tamás zoltán zsolt
ahmet burak cem emre erkan ercan fatih gökhan hakan hüseyin ismail kemal mert metin ömer orhan osman recep selim
serkan sinan tarkan tolga tuncay yasin onur volkan cengiz levent halil ilker koray oğuz serdar taner uğur
brian connor declan edward george harry james john liam neil sean seán steven stuart
arben arjan besnik bujar driton fatmir ilir valon bekim
`;

const EUROPEAN_FEMALE_FIRST_NAMES = `
alessandra alessia antonella beatrice caterina chiara cinzia elisa emanuela federica francesca gabriella giada
giorgia giovanna giulia giuseppina graziella ilaria lorena lucia mirella monica paola patrizia raffaella roberta rosa
rossella serena stefania teresa valeria vittoria
adriana alba alicia beatriz blanca carolina catalina cristina dolores inés josefa juana lucía luz marta mercedes
nuria pilar raquel rocío rosario sofía verónica ximena joana leonor mariana
amélie aurélie catherine cécile chantal christelle claire colette delphine élise émilie florence françoise géraldine
hélène isabelle jeanne josiane juliette laetitia léa lucie manon marguerite marthe mathilde mireille monique océane
pascale sandrine solène stéphanie sylvie valérie véronique virginie yvette
annemarie anouk els femke janneke lieke marieke marloes mieke noor sanne saskia wendy willemijn
birgitta camilla elin elsa freja frida hanne ingeborg linnea liv malin marit mette sigrid siri solveig ylva
aino anneli kaisa liisa minna päivi riikka satu tiina
agata agnieszka aleksandra alicja beata bożena dorota edyta elżbieta ewa grażyna halina irena iwona izabela jadwiga
joanna justyna kamila katarzyna magdalena małgorzata natalia renata sylwia urszula weronika wiesława zofia
alena hana jarmila lenka ludmila markéta pavla radka šárka věra zuzana
ankica biljana branka dragana gordana ivana jasna jelena ljiljana maja marija mirjana nataša sanja snežana suzana
vesna zorica željka mirela amra lejla emina
anastasia athina chrysa despina eleni evangelia georgia katerina panagiota vasiliki dimitra ioanna
andreea anca camelia florentina gabriela ioana irina larisa loredana mădălina mihaela oana raluca roxana simona
galina jekaterina natalja nadeschda oksana svetlana swetlana walentina julija
erzsébet ildikó katalin krisztina zsuzsanna éva
ayşe elif esra merve zeynep büşra gül hatice emine sevgi sibel songül tülay yasemin seda gamze dilek derya özge eda
emily fiona grace jane karen kate lucy mary rachel siobhan
arta blerina drita mimoza
`;

/** Names whose gender differs between countries (Andrea and Simone are male in Italy, Jasmin in Bosnia, ...). */
const AMBIGUOUS_FIRST_NAMES = `
andrea simone gabriele nicola daniele michele jasmin sascha sasha kim robin alex chris dominique camille claude
deniz umut toni noa mika jo
`;

/** Lowercase without diacritics so "Ömer" and "Omer" match the same entry. */
function foldName(name: string): string {
  return name.toLowerCase()
    .replace(/ß/g, "ss").replace(/ł/g, "l").replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ı/g, "i").replace(/đ/g, "d")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function foldedSet(...lists: Array<Iterable<string> | string>): Set<string> {
  const names = lists.flatMap((list) => typeof list === "string" ? list.split(/\s+/) : [...list]);
  return new Set(names.filter(Boolean).map(foldName));
}

const AMBIGUOUS = foldedSet(AMBIGUOUS_FIRST_NAMES);
const MALE = foldedSet(MALE_FIRST_NAMES, EUROPEAN_MALE_FIRST_NAMES);
const FEMALE = foldedSet(FEMALE_FIRST_NAMES, EUROPEAN_FEMALE_FIRST_NAMES);

const TITLE_PATTERN = /^(?:(?:dr|prof|dipl|ing)\.?(?:-\w+\.?)?\s+)+/i;

/** Guesses the gender from the first given name; undefined for unknown or unisex names. */
export function detectGenderFromName(fullName: string | undefined): Gender | undefined {
  const name = fullName?.replace(/\s+/g, " ").trim().replace(TITLE_PATTERN, "") || "";
  const parts = name.split(" ");
  if (parts.length < 2) return undefined;
  const first = foldName(parts[0].split("-")[0]);
  if (AMBIGUOUS.has(first)) return undefined;
  const male = MALE.has(first);
  const female = FEMALE.has(first);
  if (male === female) return undefined;
  return male ? "male" : "female";
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

/** "Herrn Neumann" instead of "Herrn Martin Neumann" when the salutation is certain; otherwise the full name. */
export function addressPersonDativeBySurname(fullName: string): string {
  const full = addressPersonDative(fullName);
  const match = full.match(/^(Herrn|Frau)\s+((?:(?:Dr|Prof)\.?\s+)*)(.+)$/i);
  if (!match) return full;
  return `${match[1]} ${match[2]}${match[3].split(/\s+/).at(-1)}`;
}
