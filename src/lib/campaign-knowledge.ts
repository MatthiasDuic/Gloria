import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const MAX_SOURCES = 6;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_PAGES_PER_CAMPAIGN = 100;
const MAX_TEXT_PER_PAGE = 800;
const MAX_TOTAL_TEXT = 80_000;
const REQUEST_TIMEOUT_MS = 8_000;
const CRAWL_CONCURRENCY = 8;

export class CampaignKnowledgeError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 502 = 400,
  ) {
    super(message);
    this.name = "CampaignKnowledgeError";
  }
}

export function normalizeKnowledgeSources(sources: string[]): string[] {
  const normalized = Array.from(
    new Set(
      sources
        .map((source) => source.trim())
        .filter(Boolean)
        .map((source) => {
          let url: URL;
          try {
            url = new URL(source);
          } catch {
            throw new CampaignKnowledgeError(`Ungültige Wissensquelle: ${source}`);
          }

          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            (url.port && url.port !== "443") ||
            isBlockedHostname(url.hostname) ||
            (isIP(url.hostname) > 0 && !isPublicIpAddress(url.hostname))
          ) {
            throw new CampaignKnowledgeError(
              "Wissensquellen müssen öffentliche HTTPS-Webseiten ohne Zugangsdaten sein.",
            );
          }

          url.hash = "";
          return url.toString();
        }),
    ),
  );

  if (normalized.length > MAX_SOURCES) {
    throw new CampaignKnowledgeError(`Pro Kampagne sind höchstens ${MAX_SOURCES} Wissensquellen möglich.`);
  }
  return normalized;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid") ||
    host.endsWith(".example")
  ) {
    return true;
  }
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  return (
    /^[23][0-9a-f]{0,3}:/i.test(normalized) &&
    !normalized.startsWith("2001:db8:") &&
    !normalized.startsWith("2001:0000:") &&
    !normalized.startsWith("2002:")
  );
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new CampaignKnowledgeError("Private oder reservierte IP-Adressen sind als Wissensquelle nicht erlaubt.");
    }
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }

  let addresses: LookupAddress[];
  let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        dnsTimeout = setTimeout(() => reject(new Error("DNS lookup timeout")), REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new CampaignKnowledgeError(`Die Wissensquelle ${hostname} konnte nicht aufgelöst werden.`, 502);
  } finally {
    if (dnsTimeout) clearTimeout(dnsTimeout);
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new CampaignKnowledgeError(
      `Die Wissensquelle ${hostname} verweist nicht ausschließlich auf öffentliche IP-Adressen.`,
    );
  }
  return { address: addresses[0].address, family: addresses[0].family === 6 ? 6 : 4 };
}

type PageResponse = {
  statusCode: number;
  location?: string;
  contentType: string;
  body: string;
};

function getPage(
  url: URL,
  address: { address: string; family: 4 | 6 },
  skipUnsupportedContent = false,
): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimeout);
      action();
    };
    const pinnedLookup = (
      _hostname: string,
      options: LookupOptions,
      callback: (
        error: NodeJS.ErrnoException | null,
        result: string | LookupAddress[],
        family?: number,
      ) => void,
    ) => {
      if (typeof options === "object" && options.all) {
        callback(null, [{ address: address.address, family: address.family }]);
      } else {
        callback(null, address.address, address.family);
      }
    };

    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          Accept: "text/html, application/xhtml+xml, text/plain",
          "Accept-Encoding": "identity",
          "User-Agent": "GloriaCampaignKnowledge/1.0",
        },
        lookup: pinnedLookup,
        maxHeaderSize: 16_384,
      },
      (response) => {
        response.once("end", () => clearTimeout(totalTimeout));
        const statusCode = response.statusCode || 502;
        const location = response.headers.location;
        const contentType = response.headers["content-type"] || "";
        const declaredLength = Number(response.headers["content-length"] || 0);
        if (declaredLength > MAX_RESPONSE_BYTES) {
          response.destroy();
          if (skipUnsupportedContent) {
            finish(() => resolve({ statusCode, location, contentType, body: "" }));
            return;
          }
          finish(() => reject(new CampaignKnowledgeError("Die Webseite ist größer als das erlaubte Importlimit.", 502)));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          finish(() => resolve({ statusCode, location, contentType, body: "" }));
          return;
        }
        if (!/^(text\/html|application\/xhtml\+xml|text\/plain)(;|$)/i.test(contentType)) {
          response.resume();
          if (skipUnsupportedContent) {
            finish(() => resolve({ statusCode, location, contentType, body: "" }));
            return;
          }
          finish(() => reject(new CampaignKnowledgeError("Die Wissensquelle muss eine HTML- oder Textseite sein.", 502)));
          return;
        }
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
          response.resume();
          if (skipUnsupportedContent) {
            finish(() => resolve({ statusCode, location, contentType, body: "" }));
            return;
          }
          finish(() => reject(new CampaignKnowledgeError("Komprimierte Webseiteninhalte werden nicht importiert.", 502)));
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Wissensquelle überschreitet das Importlimit."));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          finish(() => resolve({
            statusCode,
            location,
            contentType,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        });
        response.on("error", (error) => finish(() => reject(error)));
      },
    );

    const totalTimeout = setTimeout(() => {
      request.destroy(new Error("Zeitüberschreitung beim Laden der Wissensquelle."));
    }, REQUEST_TIMEOUT_MS);
    request.on("error", (error) => {
      finish(() => reject(new CampaignKnowledgeError(error.message, 502)));
    });
    request.end();
  });
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    nbsp: " ",
    lt: "<",
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === "#") {
      const codePoint = name[1]?.toLowerCase() === "x"
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : " ";
    }
    return named[name.toLowerCase()] ?? entity;
  });
}

export function extractReadableText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|svg|noscript|template|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr|\/td|\/th)\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function extractSameOriginLinks(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const links = new Set<string>();
  const hrefPattern = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

  for (const match of html.matchAll(hrefPattern)) {
    const rawHref = decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#")) continue;

    try {
      const url = new URL(rawHref, pageUrl);
      if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) continue;
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_.+|gclid|fbclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
      }
      links.add(url.toString());
    } catch {
      continue;
    }
  }
  return [...links];
}

async function readPublicPage(
  source: string,
  required: boolean,
): Promise<{ source: string; text: string; links: string[] } | null> {
  let current = new URL(source);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const address = await resolvePublicAddress(current.hostname);
    const page = await getPage(current, address, !required);
    if (page.statusCode >= 300 && page.statusCode < 400 && page.location) {
      const redirected = new URL(page.location, current);
      if (
        redirected.origin !== current.origin ||
        redirected.protocol !== "https:" ||
        redirected.username ||
        redirected.password
      ) {
        throw new CampaignKnowledgeError("Weiterleitungen auf andere Domains werden nicht importiert.", 502);
      }
      current = redirected;
      continue;
    }
    if (page.statusCode < 200 || page.statusCode >= 300) {
      if (!required) {
        console.warn("[campaign_knowledge] skipped_page", { source, statusCode: page.statusCode });
        return null;
      }
      throw new CampaignKnowledgeError(`Die Wissensquelle antwortet mit HTTP ${page.statusCode}.`, 502);
    }
    const text = extractReadableText(page.body).slice(0, MAX_TEXT_PER_PAGE);
    if (!text) {
      if (!required) {
        console.warn("[campaign_knowledge] skipped_empty_page", { source });
        return null;
      }
      throw new CampaignKnowledgeError("Auf der Wissensquelle wurde kein lesbarer Text gefunden.", 502);
    }
    return { source: current.toString(), text, links: extractSameOriginLinks(page.body, current.toString()) };
  }
  throw new CampaignKnowledgeError("Zu viele Weiterleitungen beim Laden der Wissensquelle.", 502);
}

export async function fetchCampaignKnowledge(sources: string[]): Promise<string> {
  const normalizedSources = normalizeKnowledgeSources(sources);
  if (!normalizedSources.length) return "";

  const queue = [...normalizedSources];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const pages: Array<{ source: string; text: string }> = [];
  const requiredSources = new Set(normalizedSources);

  while (queue.length && pages.length < MAX_PAGES_PER_CAMPAIGN) {
    const batch = queue.splice(0, CRAWL_CONCURRENCY);
    const results = await Promise.all(batch.map((source) => readPublicPage(source, requiredSources.has(source))));
    for (const page of results) {
      if (!page) continue;
      if (visited.has(page.source)) continue;
      visited.add(page.source);
      pages.push({ source: page.source, text: page.text });
      for (const link of page.links) {
        if (!queued.has(link) && !visited.has(link)) {
          queued.add(link);
          queue.push(link);
        }
      }
    }
  }

  if (queue.length) {
    throw new CampaignKnowledgeError(
      `Die Wissensquellen enthalten mehr als ${MAX_PAGES_PER_CAMPAIGN} erreichbare Seiten. Bitte trage gezielt die gewünschten Bereiche ein.`,
      502,
    );
  }

  const sections = pages.map(({ source, text }, index) => `[Seite ${index + 1}: ${source}]\n${text}`);
  return sections.join("\n\n").slice(0, MAX_TOTAL_TEXT);
}
