/**
 * Speech pronunciation normaliser for TechWhoKnows audio (articles & podcasts).
 * Expands acronyms, fused compounds, versions, CVEs, currencies, units, URLs,
 * and tricky technical/regional terms while preserving Fish Audio [delivery tags].
 */

export const PRONUNCIATION_MAP = new Map([
  // Databases & query languages
  ["sql", "sequel"],
  ["sqlite", "sequel-lite"],
  ["mysql", "My sequel"],
  ["postgresql", "Post-gres Q L"],
  ["postgres", "Post-gres"],
  ["nosql", "No sequel"],
  ["graphql", "Graph Q L"],
  ["duckdb", "Duck D B"],
  ["dynamodb", "Dynamo D B"],
  ["mongodb", "Mongo D B"],
  ["cockroachdb", "Cockroach D B"],
  ["clickhouse", "Click House"],
  ["supabase", "Soopa-base"],
  ["prisma", "Prizma"],

  // Cloud, DevOps, containers, networking
  ["kubectl", "kube control"],
  ["kubelet", "kube-let"],
  ["kubernetes", "Koo-ber-net-eez"],
  ["k8s", "Kates"],
  ["k3s", "K 3 S"],
  ["nginx", "engine X"],
  ["traefik", "traffic"],
  ["istio", "iss-tee-oh"],
  ["cilium", "silly-um"],
  ["ebpf", "e B P F"],
  ["grpc", "g R P C"],
  ["protobuf", "proto-buff"],
  ["oauth", "oh-auth"],
  ["oidc", "O I D C"],
  ["saml", "sam-el"],
  ["jwt", "J W T"],
  ["mtls", "m T L S"],
  ["devops", "dev-ops"],
  ["devsecops", "dev-sec-ops"],
  ["mlops", "M L-ops"],
  ["llmops", "L L M-ops"],
  ["finops", "fin-ops"],
  ["gitops", "git-ops"],
  ["sysadmin", "sis-admin"],
  ["netops", "net-ops"],
  ["secops", "sec-ops"],
  ["localhost", "local host"],
  ["cidr", "cider"],
  ["ifconfig", "if config"],
  ["systemctl", "system control"],
  ["journalctl", "journal control"],
  ["sudo", "soo-doo"],
  ["chmod", "ch-mod"],
  ["chown", "ch-own"],
  ["stdin", "standard in"],
  ["stdout", "standard out"],
  ["stderr", "standard error"],
  ["daemon", "dee-mon"],
  ["daemons", "dee-mons"],
  ["qemu", "Q-em-you"],
  ["nixos", "Nix O S"],
  ["freebsd", "Free B S D"],
  ["openbsd", "Open B S D"],
  ["centos", "Cent O S"],
  ["redhat", "Red Hat"],
  ["ubuntu", "oo-boon-too"],
  ["debian", "deb-ee-an"],
  ["kali", "kah-lee"],

  // Languages, runtimes, tools, formats
  ["pypi", "Pie P I"],
  ["uv", "U V"],
  ["npm", "N P M"],
  ["pnpm", "P N P M"],
  ["npx", "N P X"],
  ["nodejs", "Node J S"],
  ["nextjs", "Next J S"],
  ["reactjs", "React J S"],
  ["vuejs", "View J S"],
  ["vue", "view"],
  ["svelte", "svelt"],
  ["vite", "veet"],
  ["esbuild", "E S build"],
  ["swc", "S W C"],
  ["turbopack", "turbo-pack"],
  ["wasm", "waz-um"],
  ["webassembly", "Web Assembly"],
  ["typescript", "Type Script"],
  ["javascript", "Java Script"],
  ["json", "jayson"],
  ["jsonl", "jayson L"],
  ["yaml", "yammel"],
  ["toml", "tommel"],
  ["regex", "redge-ex"],
  ["ascii", "ass-key"],
  ["utf8", "U T F 8"],
  ["utf-8", "U T F 8"],
  ["latex", "lay-tech"],
  ["gui", "gooey"],
  ["tui", "T U I"],
  ["wysiwyg", "wizzy-wig"],
  ["linq", "link"],
  ["golang", "Go-lang"],
  ["fastapi", "Fast A P I"],
  ["pydantic", "Pie-dantic"],
  ["pytorch", "Pie-torch"],
  ["tensorflow", "Tensor Flow"],
  ["scikit", "sigh-kit"],
  ["numpy", "num-pie"],
  ["scipy", "sigh-pie"],
  ["jupyter", "Jupiter"],
  ["github", "Git Hub"],
  ["gitlab", "Git Lab"],
  ["bitbucket", "Bit Bucket"],
  ["vscode", "V S Code"],
  ["neovim", "Neo-vim"],
  ["tmux", "T-mux"],
  ["jq", "J Q"],
  ["yq", "Y Q"],
  ["ffmpeg", "F F em-peg"],
  ["imagemagick", "Image Magic"],
  ["opengl", "Open G L"],
  ["webgl", "Web G L"],
  ["webgpu", "Web G P U"],
  ["directx", "Direct X"],
  ["cuda", "koo-da"],
  ["cudnn", "koo-D N N"],
  ["rocm", "rock-em"],
  ["triton", "try-ton"],
  ["async", "ay-sink"],
  ["sync", "sink"],
  ["deque", "deck"],
  ["enum", "ee-num"],
  ["kwargs", "K W args"],

  // AI, models, companies, hardware
  ["openai", "Open A I"],
  ["chatgpt", "Chat G P T"],
  ["gpt", "G P T"],
  ["deepseek", "Deep Seek"],
  ["xai", "X A I"],
  ["qwen", "Kwen"],
  ["mistral", "miss-trahl"],
  ["mixtral", "mix-trahl"],
  ["skhynix", "S K Hynix"],
  ["hbm3e", "H B M 3 E"],
  ["hbm4", "H B M 4"],
  ["nvme", "N V M e"],
  ["nvlink", "N V Link"],
  ["pcie", "P C I E"],
  ["gddr6", "G D D R 6"],
  ["gddr7", "G D D R 7"],
  ["ddr5", "D D R 5"],
  ["lpddr5", "L P D D R 5"],
  ["sram", "S-ram"],
  ["dram", "D-ram"],
  ["vram", "V-ram"],
  ["asic", "ay-sick"],
  ["asics", "ay-sicks"],
  ["risc-v", "risk five"],
  ["riscv", "risk five"],
  ["x86", "X 86"],
  ["aarch64", "A-arch 64"],
  ["arm64", "Arm 64"],
  ["vllm", "V L L M"],
  ["ollama", "oh-lah-ma"],
  ["gguf", "G G U F"],
  ["lora", "low-ra"],
  ["qlora", "Q-low-ra"],
  ["kv-cache", "K V cache"],
  ["fp8", "F P 8"],
  ["fp16", "F P 16"],
  ["fp32", "F P 32"],
  ["bf16", "B F 16"],
  ["int4", "int 4"],
  ["int8", "int 8"],
  ["h100", "H 100"],
  ["h200", "H 200"],
  ["b200", "B 200"],
  ["gb200", "G B 200"],
  ["a100", "A 100"],
  ["ios", "I O S"],
  ["ipados", "iPad O S"],
  ["macos", "Mac O S"],
  ["watchos", "Watch O S"],
  ["tvos", "T V O S"],
  ["visionos", "Vision O S"],
  ["wi-fi", "why-fie"],
  ["wifi", "why-fie"],
  ["saas", "sass"],
  ["paas", "pass"],
  ["iaas", "I-as"],
  ["baas", "bass"],
  ["faas", "fass"],
  ["ciso", "see-so"],
  ["cisos", "see-sos"],
  ["soc2", "sock two"],
  ["iso27001", "I S O 27001"],
  ["hipaa", "hippa"],
  ["nis2", "N I S 2"],
  ["mitre", "my-ter"],
  ["owasp", "oh-wasp"],
  ["cisa", "see-sa"],
  ["icann", "eye-can"],
  ["ieee", "I triple E"],
  ["w3c", "W 3 C"],

  // Singapore / APAC / regional
  ["apac", "A-Pac"],
  ["asean", "ah-see-an"],
  ["govtech", "Gov Tech"],
  ["singtel", "Sing-tel"],
  ["starhub", "Star-hub"],
  ["shopee", "Shop-ee"],
  ["lazada", "La-zah-da"],
  ["johor", "Jo-hor"],
  ["batam", "Ba-tam"],
  ["jurong", "Joo-rong"],
  ["js-sez", "J S S E Z"],

  // General & brand
  ["tldr", "T L D R"],
  ["fyi", "F Y I"],
  ["btw", "by the way"],
  ["readme", "read me"],
  ["changelog", "change log"],
  ["monorepo", "mono repo"],
  ["techwhoknows", "Tech Who Knows"],
]);

export const SPELLED_ACRONYMS = new Set([
  "NSA", "PHP", "API", "SDK", "CLI", "SSH", "TLS", "SSL", "DNS", "HTTP", "HTTPS", "FTP", "SFTP", "SMTP", "IMAP",
  "URL", "URI", "HTML", "CSS", "XML", "CSV", "PDF", "SQL", "FBI", "CIA", "SEC", "FTC", "DOJ", "FCC", "GCHQ",
  "MAS", "IMDA", "CSA", "MTI", "EDB", "AI", "ML", "DL", "RL", "NLP", "CV", "LLM", "VLM", "SLM", "RAG", "MCP", "AGI", "ASI",
  "AWS", "GCP", "OCI", "VPC", "IAM", "MFA", "2FA", "SSO", "VPN", "CVE", "CWE", "CVSS", "RCE", "XSS", "CSRF", "SSRF", "SQLI",
  "CDN", "ISP", "IXP", "B2B", "B2C", "D2C", "IPO", "SPAC", "VC", "PE", "ARR", "MRR", "NRR", "CAC", "LTV", "ROI", "KPI", "OKR",
  "CEO", "CTO", "CFO", "COO", "CMO", "CPO", "CRO", "CIO", "CSO", "VP", "SVP", "EVP", "GM",
  "GPU", "CPU", "TPU", "NPU", "DPU", "APU", "SOC", "USB", "HDMI", "DP", "RAM", "ROM", "SSD", "HDD", "NAS", "SAN",
  "OS", "VM", "KVM", "LXC", "WSL", "BIOS", "UEFI", "TPM", "HSM", "PKI", "CA",
  "TCP", "UDP", "IP", "ICMP", "ARP", "NAT", "BGP", "ASN", "MAC", "VLAN", "DHCP", "NTP", "SNMP",
  "SIEM", "SOAR", "EDR", "XDR", "MDR", "NDR", "DLP", "WAF", "IDS", "IPS",
  "CNN", "BBC", "CNBC", "FT", "WSJ", "NYT", "MIT", "NTU", "NUS", "SMU", "SUTD",
  "RGB", "HDR", "SDR", "OLED", "LCD", "LED", "FPS", "DPI", "PPI", "PUE", "SLA", "SLO", "SLI", "MTTR", "MTBF", "RTO", "RPO",
  "MOU", "NDA", "RFP", "RFQ", "TCO", "BOM", "SKU", "ERP", "CRM", "HRIS", "HCM", "POS", "QR", "NFC", "RFID", "BLE", "IOT", "IIOT",
  "CI", "CD", "PR", "MR", "QA", "QE", "UAT", "SRE", "SWE", "MLE",
  "HBM", "DDR", "PCI", "EUV", "DUV", "TSMC", "ASML", "AMD", "IBM", "HP", "SAP",
  "FPGA", "RLHF", "GRPO", "MOE", "KV", "GDPR", "PDPA", "IETF", "AMA", "FAQ", "TWK",
  "SGD", "USD", "EUR", "GBP", "JPY", "CNY", "RMB", "MYR", "IDR", "INR", "AUD", "CAD", "HKD", "TWD", "KRW",
  "EU", "UK", "US", "USA", "UN", "NATO", "OECD", "WTO",
]);

const CURRENCY_PREFIXES = {
  "US$": "U S dollars",
  "S$": "Singapore dollars",
  "SG$": "Singapore dollars",
  "A$": "Australian dollars",
  "HK$": "Hong Kong dollars",
  "$": "dollars",
  "€": "euros",
  "£": "pounds",
  "¥": "yen",
};

const SCALE_WORDS = {
  k: "thousand",
  m: "million",
  b: "billion",
  t: "trillion",
};

const UNIT_WORDS = {
  gbps: "gigabits per second",
  mbps: "megabits per second",
  kbps: "kilobits per second",
  tbps: "terabits per second",
  ghz: "gigahertz",
  mhz: "megahertz",
  khz: "kilohertz",
  hz: "hertz",
  tb: "terabytes",
  gb: "gigabytes",
  mb: "megabytes",
  kb: "kilobytes",
  pb: "petabytes",
  gw: "gigawatts",
  mw: "megawatts",
  kw: "kilowatts",
  ms: "milliseconds",
  ns: "nanoseconds",
  nm: "nanometre",
  "km/h": "kilometres per hour",
};

function spaceAcronym(word) {
  return word.split("").join(" ");
}

function normalizeToken(token) {
  const mapped = PRONUNCIATION_MAP.get(token.toLowerCase());
  if (mapped) return mapped;

  // Possessive of a mapped word or spelled acronym: GitHub's -> Git Hub's, NSA's -> N S A's
  const possessive = token.match(/^([A-Za-z0-9-]+)(['’]s)$/);
  if (possessive) {
    const [, base, suffix] = possessive;
    const baseNormalized = normalizeToken(base);
    if (baseNormalized !== base) return `${baseNormalized}${suffix}`;
  }

  // Hyphenated compound (e.g. AI-powered, GPU-rich, USB-C, x86-64)
  if (token.includes("-")) {
    return token
      .split("-")
      .map((part) => (part ? normalizeToken(part) : part))
      .join("-");
  }

  // Plural ALLCAPS acronym: APIs -> A P I's, GPUs -> G P U's, LLMs -> L L M's
  if (/^[A-Z0-9]{2,}s$/.test(token) && SPELLED_ACRONYMS.has(token.slice(0, -1))) {
    return `${spaceAcronym(token.slice(0, -1))}'s`;
  }

  // Fused ALLCAPS + TitleCase word: NSANet -> N S A Net, AWSLambda -> A W S Lambda
  if (/^[A-Z]{2,}[A-Z][a-z]{2,}$/.test(token)) {
    return token.replace(/^([A-Z]{2,})([A-Z][a-z]{2,})$/, (_, acr, rest) => {
      const acrMapped = PRONUNCIATION_MAP.get(acr.toLowerCase()) || spaceAcronym(acr);
      return `${acrMapped} ${rest}`;
    });
  }

  // Fused Word + ALLCAPS suffix: FastAPI -> Fast A P I, xAI -> x A I
  if (/^[A-Za-z][a-z]{0,}[A-Z]{2,}$/.test(token)) {
    return token.replace(/^([A-Za-z][a-z]{0,})([A-Z]{2,})$/, (_, head, acr) => {
      const acrMapped = PRONUNCIATION_MAP.get(acr.toLowerCase()) || spaceAcronym(acr);
      return `${head} ${acrMapped}`;
    });
  }

  if (SPELLED_ACRONYMS.has(token)) {
    return spaceAcronym(token);
  }

  return token;
}

function expandUrl(rawUrl) {
  const clean = rawUrl.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const [host, ...rest] = clean.split("/");
  const spokenHost = host
    .split(".")
    .map((part) => PRONUNCIATION_MAP.get(part.toLowerCase()) || part)
    .join(" dot ");
  if (rest.length === 0) return spokenHost;
  const spokenPath = rest
    .map((seg) => seg.replace(/[-_]+/g, " "))
    .join(" slash ");
  return `${spokenHost} slash ${spokenPath}`;
}

/**
 * Normalises technical acronyms, fused compounds, versions, CVEs, currencies,
 * units, URLs, and tricky words for natural TTS pronunciation while preserving [Fish tags].
 */
export function normalizeForSpeech(rawText) {
  const parts = String(rawText || "").split(/(\[[^\]]{1,32}\])/g);
  return parts
    .map((part) => {
      if (/^\[sfx:[^\]]+\]$/i.test(part)) return "";
      if (part.startsWith("[") && part.endsWith("]")) return part;

      let out = part;

      // Strip stray markdown formatting so TTS never speaks asterisks or backticks.
      out = out.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");

      // Emails and URLs / domains
      out = out.replace(/\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[a-z]{2,})\b/gi, (_, user, domain) => {
        return `${user.replace(/[._-]+/g, " ")} at ${expandUrl(domain)}`;
      });
      out = out.replace(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|gov|edu|sg|co|uk)(?:\/[^\s,;)]*)?/gi, (url) => {
        return expandUrl(url);
      });

      // Common slash & ampersand idioms
      out = out.replace(/\b24\/7\b/g, "twenty-four seven");
      out = out.replace(/\bI\/O\b/g, "I O");
      out = out.replace(/\bCI\/CD\b/g, "C I C D");
      out = out.replace(/\bTCP\/IP\b/g, "T C P I P");
      out = out.replace(/\bR&D\b/g, "R and D");
      out = out.replace(/\bM&A\b/g, "M and A");
      out = out.replace(/\bQ&A\b/g, "Q and A");
      out = out.replace(/\bS&P\b/g, "S and P");
      out = out.replace(/\bAT&T\b/g, "A T and T");
      out = out.replace(/\s&\s/g, " and ");

      // Common abbreviations
      out = out.replace(/\be\.g\.,?\s*/gi, "for example, ");
      out = out.replace(/\bi\.e\.,?\s*/gi, "that is, ");
      out = out.replace(/\betc\./gi, "et cetera");
      out = out.replace(/\bvs\.?(?=\s)/gi, "versus");

      // CVE-2026-1234 -> C V E 2026, 1234
      out = out.replace(/\bCVE-(\d{4})-(\d+)\b/gi, (_, y, n) => `C V E ${y}, ${n}`);
      // Version numbers like v2.1 or v2.1.3 -> version 2 point 1
      out = out.replace(/\bv(\d+(?:\.\d+)+)\b/gi, (_, v) => `version ${v.replace(/\./g, " point ")}`);
      out = out.replace(/\bIPv([46])\b/g, "I P v $1");

      // Currencies: $4.5M -> 4.5 million dollars, S$12M -> 12 million Singapore dollars
      out = out.replace(/(US\$|SG\$|HK\$|S\$|A\$|[$€£¥])\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*([KMBT])?\b/gi, (_, sym, num, scale) => {
        const currency = CURRENCY_PREFIXES[sym.toUpperCase()] || CURRENCY_PREFIXES[sym] || "dollars";
        const scaleWord = scale ? ` ${SCALE_WORDS[scale.toLowerCase()]}` : "";
        return `${num}${scaleWord} ${currency}`;
      });

      // Numeric + unit compounds: 200ms, 128GB, 130kW, 3nm, 10Gbps
      out = out.replace(/\b(\d+(?:\.\d+)?)\s*(Gbps|Mbps|kbps|Tbps|GHz|MHz|kHz|Hz|TB|GB|MB|KB|PB|GW|MW|kW|ms|ns|nm|km\/h)\b/g, (_, num, unit) => {
        return `${num} ${UNIT_WORDS[unit.toLowerCase()] || unit}`;
      });

      // Approximate numbers and percentages
      out = out.replace(/~(\d)/g, "about $1");
      out = out.replace(/(\d+(?:\.\d+)?)%/g, "$1 percent");
      out = out.replace(/(\d+)\s*×/g, "$1x");

      // Em/en dashes -> natural pause; slash between words -> or
      out = out.replace(/\s*[—–]\s*/g, ", ");
      out = out.replace(/\b([A-Za-z]{2,})\/([A-Za-z]{2,})\b/g, "$1 or $2");

      // Word-level pronunciation mapping
      out = out.replace(/\b[A-Za-z][A-Za-z0-9'’-]*\b/g, normalizeToken);

      return out;
    })
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}
