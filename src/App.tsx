import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * UMass Lab Chatbot Builder (Single-file React app)
 * -------------------------------------------------
 * Front-end for professors/labs to enter Q&A pairs and submit a chatbot request.
 *
 * Tech: React + TailwindCSS (single file for easy drop-in into Vite/Next.js).
 */

// ---------- Backend config (Option A: direct to service port) ----------
const BACKEND_BASE =
  (import.meta as any)?.env?.VITE_BACKEND_BASE || "http://128.119.128.176:8081";
const SUBMIT_URL = `${BACKEND_BASE}/chatbots`;
const HEALTH_URL = `${BACKEND_BASE}/health`;

// ---------- Types ----------

type QAPair = {
  id: string;
  q: string;
  a: string;
  tags?: string[];
};

type BotMeta = {
  lab: string;
  botName: string;
  ownerEmail: string;
  description?: string;
  baseModel: string; // e.g., "qwen2.5:7b-instruct"
  embedModel: string; // e.g., "nomic-embed-text"
  temperature: number;
  topP: number;
};

type ExportPayload = {
  bot: {
    name: string;
    lab: string;
    owner_email: string;
    description?: string;
    slug: string;
    model: string;
    embed_model: string;
    temperature: number;
    top_p: number;
  };
  pairs: Array<{ q: string; a: string; tags?: string[] }>;
  created_at: string;
  version: string;
};

// ---------- Utils ----------

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function classNames(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(" ");
}

// Simple metadata validator used by UI and tests
function validateMeta(meta: BotMeta) {
  return (
    meta.lab.trim().length > 0 &&
    meta.botName.trim().length > 0 &&
    /.+@.+\..+/.test(meta.ownerEmail)
  );
}

// ---------- Flexible JSON Import ----------

type LooseQ = string | null | undefined;
type LooseA = string | null | undefined;

function coerceStr(x: any): string {
  return (typeof x === "string" ? x : String(x ?? "")).trim();
}

function extractQAFromObject(obj: any): { q: string; a: string; tags?: string[] } | null {
  if (!obj || typeof obj !== "object") return null;

  const qKey = ["q", "question", "prompt", "ask", "query", "Q"].find(k => k in obj);
  const aKey = ["a", "answer", "response", "text", "A"].find(k => k in obj);
  if (!qKey || !aKey) return null;

  const q = coerceStr(obj[qKey]);
  const a = coerceStr(obj[aKey]);
  if (!q || !a) return null;

  let tags: string[] | undefined;
  if (Array.isArray((obj as any).tags)) {
    tags = (obj as any).tags.map(coerceStr).filter(Boolean);
    if (!tags.length) tags = undefined;
  }
  return { q, a, tags };
}

function extractQAFromArray(arr: any[]): { q: string; a: string; tags?: string[] } | null {
  if (!Array.isArray(arr)) return null;
  if (arr.length < 2) return null;
  const q = coerceStr(arr[0]);
  const a = coerceStr(arr[1]);
  if (!q || !a) return null;
  // optional 3rd item can be tags array or comma string
  let tags: string[] | undefined;
  if (arr.length >= 3) {
    if (Array.isArray(arr[2])) tags = arr[2].map(coerceStr).filter(Boolean);
    else tags = coerceStr(arr[2]).split(",").map(s => s.trim()).filter(Boolean);
    if (!tags.length) tags = undefined;
  }
  return { q, a, tags };
}

/**
 * Accepts:
 * - ExportPayload { bot, pairs }
 * - Raw array of QA objects: [ {q,a}, ... ], or [{question,answer}, ...]
 * - Array of tuples: [ ["q","a"], ... ] (3rd element optional tags)
 * - Wrapped objects: { pairs|data|faqs|items|records: [...] }
 * - JSONL (one JSON per line)
 */
function parseAnyQAPairs(jsonText: string): {
  metaPatch?: Partial<BotMeta>;
  pairs: { q: string; a: string; tags?: string[] }[];
} {
  // 1) Try normal JSON first
  try {
    const data = JSON.parse(jsonText);

    // If full ExportPayload
    if (data && typeof data === "object" && "bot" in data && "pairs" in data && Array.isArray((data as any).pairs)) {
      const bot = (data as any).bot ?? {};
      const metaPatch: Partial<BotMeta> | undefined = {
        lab: coerceStr(bot.lab || ""),
        botName: coerceStr(bot.name || ""),
        ownerEmail: coerceStr(bot.owner_email || ""),
        description: coerceStr(bot.description || ""),
        baseModel: coerceStr(bot.model || "qwen2.5:7b-instruct"),
        embedModel: coerceStr(bot.embed_model || "nomic-embed-text"),
        temperature: typeof bot.temperature === "number" ? bot.temperature : 0.2,
        topP: typeof bot.top_p === "number" ? bot.top_p : 0.95,
      };

      const pairs = ((data as any).pairs as any[])
        .map(item => (Array.isArray(item) ? extractQAFromArray(item) : extractQAFromObject(item)))
        .filter(Boolean) as { q: string; a: string; tags?: string[] }[];

      if (!pairs.length) throw new Error("No valid Q/A items found in ExportPayload.pairs");
      return { metaPatch, pairs };
    }

    // If raw array
    if (Array.isArray(data)) {
      const pairs = data
        .map(item => (Array.isArray(item) ? extractQAFromArray(item) : extractQAFromObject(item)))
        .filter(Boolean) as { q: string; a: string; tags?: string[] }[];
      if (!pairs.length) throw new Error("No valid Q/A rows in array");
      return { pairs };
    }

    // If wrapped under common keys
    if (data && typeof data === "object") {
      const wrapKey = ["pairs", "data", "faqs", "items", "records"].find(k => Array.isArray((data as any)[k]));
      if (wrapKey) {
        const arr: any[] = (data as any)[wrapKey];
        const pairs = arr
          .map(item => (Array.isArray(item) ? extractQAFromArray(item) : extractQAFromObject(item)))
          .filter(Boolean) as { q: string; a: string; tags?: string[] }[];
        if (!pairs.length) throw new Error(`No valid Q/A under '${wrapKey}'`);
        return { pairs };
      }
    }
  } catch {
    // fallthrough to JSONL attempt
  }

  // 2) Try JSON Lines (JSONL): one JSON per line
  const lines = jsonText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const fromJsonl: { q: string; a: string; tags?: string[] }[] = [];
  if (lines.length > 1) {
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        let qa = null;
        if (Array.isArray(obj)) qa = extractQAFromArray(obj);
        else qa = extractQAFromObject(obj);
        if (qa) fromJsonl.push(qa);
      } catch {
        // ignore bad lines
      }
    }
    if (fromJsonl.length) return { pairs: fromJsonl };
  }

  // 3) If nothing matched:
  throw new Error("Unsupported JSON format: could not find Q/A pairs");
}

// ---------- Mini UI primitives (Tailwind) ----------

function Card({ children, className = "" }: React.PropsWithChildren<{ className?: string }>) {
  return (
    <div className={classNames("rounded-2xl shadow-sm border border-gray-200 bg-white/60 backdrop-blur p-5", className)}>
      {children}
    </div>
  );
}

function SectionHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {subtitle ? <p className="text-sm text-gray-500">{subtitle}</p> : null}
    </div>
  );
}

function Label({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium text-gray-700">
      {children}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={classNames(
        "w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm",
        "outline-none ring-0 focus:border-indigo-500",
        (props.className as string) || ""
      )}
    />
  );
}

// Forward ref so we can focus() it in the Import dialog
const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  (props, ref) => (
    <textarea
      ref={ref}
      {...props}
      className={classNames(
        "w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm",
        "outline-none ring-0 focus:border-indigo-500 min-h-[100px]",
        (props.className as string) || ""
      )}
    />
  )
);
Textarea.displayName = "Textarea";

function Button(
  { variant = "default", className = "", ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "secondary" | "danger" | "ghost" }
) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium transition";
  const variants: Record<string, string> = {
    default: "bg-indigo-600 text-white hover:bg-indigo-500",
    secondary: "bg-gray-100 text-gray-900 hover:bg-gray-200",
    danger: "bg-rose-600 text-white hover:bg-rose-500",
    ghost: "bg-transparent text-gray-700 hover:bg-gray-100",
  };
  return <button {...props} className={classNames(base, variants[variant], className)} />;
}

function Tiny({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-gray-500">{children}</span>;
}

// ---------- Self-tests (console) ----------

function runSelfTests() {
  try {
    // slugify tests
    console.assert(slugify("Hello World!") === "hello-world", "slugify basic failed");
    console.assert(slugify("IALS — Houmansadr Lab") === "ials-houmansadr-lab", "slugify em-dash/diacritics failed");

    // payload mapping tests
    const pairsIn = [
      { q: " Q1 ", a: " A1 ", tags: [] as string[] },
      { q: "Q2", a: "A2", tags: ["policy"] },
    ];
    const mapped = pairsIn.map(({ q, a, tags }) => ({ q: q.trim(), a: a.trim(), tags: tags && tags.length ? tags : undefined }));
    console.assert(mapped[0].q === "Q1" && mapped[0].a === "A1" && mapped[0].tags === undefined, "pair trim/tags mapping failed");
    console.assert(mapped[1].tags && mapped[1].tags[0] === "policy", "pair tags carry-over failed");

    // email regex sanity + meta validator
    console.assert(/.+@.+\..+/.test("name@umass.edu"), "email regex basic failed");
    const metaBad: BotMeta = { lab: "", botName: "", ownerEmail: "x", description: "", baseModel: "x", embedModel: "y", temperature: 0.2, topP: 0.9 };
    const metaGood: BotMeta = { lab: "IALS", botName: "Privacy-LLM", ownerEmail: "prof@umass.edu", description: "", baseModel: "qwen2.5:7b-instruct", embedModel: "nomic-embed-text", temperature: 0.2, topP: 0.95 };
    console.assert(!validateMeta(metaBad), "validateMeta should fail for bad meta");
    console.assert(validateMeta(metaGood), "validateMeta should pass for good meta");

    // extra: pairs validity check
    const somePairs: QAPair[] = [
      { id: "1", q: "What is RAG?", a: "Retrieval-Augmented Generation.", tags: [] },
      { id: "2", q: " ", a: " ", tags: [] },
    ];
    console.assert(somePairs.some(p => p.q.trim() && p.a.trim()), "pairs validity should detect at least one completed pair");
  } catch (err) {
    console.warn("Self-tests encountered an issue:", err);
  }
}

// ---------- Main Component ----------

export default function App() {
  // Run lightweight console self-tests once
  useEffect(() => {
    runSelfTests();
  }, []);

  // Metadata
  const [meta, setMeta] = useState<BotMeta>({
    lab: "",
    botName: "",
    ownerEmail: "",
    description: "",
    baseModel: "qwen2.5:7b-instruct",
    embedModel: "nomic-embed-text",
    temperature: 0.2,
    topP: 0.95,
  });

  // QA pairs
  const [pairs, setPairs] = useState<QAPair[]>([{ id: uid(), q: "", a: "", tags: [] }]);

  // UI state
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("{}");
  const importTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFileName, setSelectedFileName] = useState("");
  const [backendOk, setBackendOk] = useState<null | boolean>(null);

  // submit banners
  const [submitState, setSubmitState] = useState<"idle" | "success" | "error">("idle");
  const [submitMessage, setSubmitMessage] = useState<string>("");

  // Local persistence
  useEffect(() => {
    const saved = localStorage.getItem("umass-chatbot-builder");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.meta) setMeta(parsed.meta);
        if (parsed.pairs) setPairs(parsed.pairs);
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("umass-chatbot-builder", JSON.stringify({ meta, pairs }));
  }, [meta, pairs]);

  // Backend health badge
  useEffect(() => {
    fetch(HEALTH_URL, { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(() => setBackendOk(true))
      .catch(() => setBackendOk(false));
  }, []);

  // Derived (slug kept for payload only; not shown in UI)
  const slug = useMemo(() => {
    const labSlug = slugify(meta.lab || "lab");
    const botSlug = slugify(meta.botName || "bot");
    return `${labSlug}-${botSlug}`;
  }, [meta.lab, meta.botName]);

  const exportPayload: ExportPayload = useMemo(() => {
    const safePairs = Array.isArray(pairs) ? pairs : [];
    const payload: ExportPayload = {
      bot: {
        name: meta?.botName?.trim() || "Untitled Bot",
        lab: meta?.lab?.trim() || "",
        owner_email: meta?.ownerEmail?.trim() || "",
        description: meta?.description?.trim() || undefined,
        slug,
        model: meta?.baseModel || "qwen2.5:7b-instruct",
        embed_model: meta?.embedModel || "nomic-embed-text",
        temperature: typeof meta?.temperature === "number" ? meta.temperature : 0.2,
        top_p: typeof meta?.topP === "number" ? meta.topP : 0.95,
      },
      pairs: safePairs.map(({ q, a, tags }) => ({
        q: (q || "").trim(),
        a: (a || "").trim(),
        tags: tags && tags.length ? tags : undefined,
      })),
      created_at: new Date().toISOString(),
      version: "2025-09-16",
    };
    return payload;
  }, [meta, pairs, slug]);

  const isValid = useMemo(() => {
    const hasMeta = validateMeta(meta);
    const hasPairs = pairs.some(p => (p.q || "").trim() && (p.a || "").trim());
    return Boolean(hasMeta && hasPairs);
  }, [meta, pairs]);

  // Handlers
  function updatePair(id: string, patch: Partial<QAPair>) {
    setPairs(prev => prev.map(p => (p.id === id ? { ...p, ...patch } : p)));
  }
  function addPair() {
    setPairs(prev => [...prev, { id: uid(), q: "", a: "", tags: [] }]);
  }
  function removePair(id: string) {
    setPairs(prev => (prev.length <= 1 ? prev : prev.filter(p => p.id !== id)));
  }
  function movePair(id: string, dir: -1 | 1) {
    setPairs(prev => {
      const idx = prev.findIndex(p => p.id === id);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const clone = [...prev];
      const [item] = clone.splice(idx, 1);
      clone.splice(target, 0, item);
      return clone;
    });
  }

  async function handleSubmit() {
    if (!isValid) {
      setSubmitState("error");
      setSubmitMessage("Please complete Lab, Bot name, Owner email, and at least one Q/A pair.");
      return;
    }
    try {
      setSubmitState("idle");
      setSubmitMessage("");
      const res = await fetch(SUBMIT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exportPayload),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
      }

      // optional: consume response (file name, etc.), but message is fixed per your request
      await res.json().catch(() => ({}));

      setSubmitState("success");
      setSubmitMessage("Request submitted successfully — please allow 1 business day for your customized chatbot to be deployed!");
    } catch (e: any) {
      setSubmitState("error");
      setSubmitMessage(`Submission failed. ${e?.message || e}`);
    }
  }

  function handleImportJSON() {
    try {
      // Strip common trailing commas (e.g., after last element in an array/object)
      const sanitized = importText.replace(/,\s*([\]}])/g, "$1");

      const { metaPatch, pairs: incoming } = parseAnyQAPairs(sanitized);

      if (metaPatch) {
        setMeta(prev => ({
          ...prev,
          lab: metaPatch.lab ?? prev.lab,
          botName: metaPatch.botName ?? prev.botName,
          ownerEmail: metaPatch.ownerEmail ?? prev.ownerEmail,
          description: metaPatch.description ?? prev.description,
          baseModel: metaPatch.baseModel ?? prev.baseModel,
          embedModel: metaPatch.embedModel ?? prev.embedModel,
          temperature: metaPatch.temperature ?? prev.temperature,
          topP: metaPatch.topP ?? prev.topP,
        }));
      }

      setPairs(incoming.map(p => ({ id: uid(), q: p.q, a: p.a, tags: p.tags ?? [] })));
      setImportOpen(false);
    } catch (e: any) {
      setSubmitState("error");
      setSubmitMessage("Could not import JSON: " + (e?.message || String(e)));
    }
  }

  function handleReset() {
    if (!confirm("Clear all fields? This cannot be undone.")) return;
    localStorage.removeItem("umass-chatbot-builder");
    setMeta({
      lab: "",
      botName: "",
      ownerEmail: "",
      description: "",
      baseModel: "qwen2.5:7b-instruct",
      embedModel: "nomic-embed-text",
      temperature: 0.2,
      topP: 0.95,
    });
    setPairs([{ id: uid(), q: "", a: "", tags: [] }]);
    setImportText("{}");
    setImportOpen(false);
    setSelectedFileName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    setSubmitState("idle");
    setSubmitMessage("");
  }

  function handleFileOpen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(String(reader.result || ""));
      setImportOpen(true);
      setTimeout(() => importTextAreaRef.current?.focus(), 50);
    };
    reader.readAsText(file);
  }

  // ---------- Render ----------
  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-indigo-50 via-white to-violet-50 text-gray-900">
      <div className="mx-auto max-w-6xl px-5 py-8">
        {/* Header */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">UMass Lab Chatbot Builder</h1>
              <p className="text-sm text-gray-600">Create RAG-ready Q&A datasets for lab/professor chatbots.</p>
            </div>
            {backendOk === null ? (
              <span className="text-xs text-gray-500">checking backend…</span>
            ) : backendOk ? (
              <span className="text-xs rounded bg-green-100 text-green-700 px-2 py-0.5">backend: OK</span>
            ) : (
              <span className="text-xs rounded bg-rose-100 text-rose-700 px-2 py-0.5">backend: unreachable</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="danger" onClick={handleReset}>Reset</Button>
          </div>
        </div>

        {/* Status banner */}
        {submitState !== "idle" && submitMessage && (
          <div
            className={classNames(
              "mb-6 rounded-xl border px-4 py-3 text-sm",
              submitState === "success"
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-rose-200 bg-rose-50 text-rose-700"
            )}
            role="status"
          >
            {submitMessage}
          </div>
        )}

        {/* Grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left column: Meta & Submit */}
          <div className="lg:col-span-1 space-y-6">
            <Card>
              <SectionHeading title="Submit your chatbot" subtitle="Enter details and submit when ready." />
              <div className="space-y-4">
                <div>
                  <Label htmlFor="lab">Lab / Group</Label>
                  <Input id="lab" placeholder="e.g., IALS — Light Microscopy Lab" value={meta.lab} onChange={(e) => setMeta({ ...meta, lab: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="botName">Bot name</Label>
                  <Input id="botName" placeholder="e.g., Microscope Helper" value={meta.botName} onChange={(e) => setMeta({ ...meta, botName: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="email">Owner email</Label>
                  <Input id="email" type="email" placeholder="name@umass.edu" value={meta.ownerEmail} onChange={(e) => setMeta({ ...meta, ownerEmail: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="desc">Short description</Label>
                  <Textarea id="desc" placeholder="What should users ask this bot?" value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
                </div>
                <div className="flex items-center gap-2">
                  <Button onClick={handleSubmit} disabled={!isValid} title={isValid ? "Submit" : "Fill required fields & at least one Q/A"}>
                    Submit
                  </Button>
                  <Tiny>POST → {SUBMIT_URL.replace(/^https?:\/\//, "")}</Tiny>
                </div>
              </div>
            </Card>

            <Card>
              <SectionHeading title="Import" subtitle="Paste or upload a JSON to continue." />
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => setImportOpen(true)}>Paste JSON</Button>
                  <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>Upload JSON</Button>
                  <input ref={fileInputRef} type="file" accept="application/json" onChange={handleFileOpen} className="hidden" />
                </div>
                {selectedFileName && (
                  <div className="text-xs text-gray-500">Selected: {selectedFileName}</div>
                )}
              </div>
            </Card>
          </div>

          {/* Right column: Q/A editor */}
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <SectionHeading title="Q&A pairs" subtitle="Add questions and their answers. Use tags (comma-separated) to group topics or courses." />
              <div className="space-y-4">
                {pairs.map((pair, idx) => (
                  <div key={pair.id} className="rounded-xl border border-gray-200 p-4">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs font-medium text-gray-500">#{idx + 1}</div>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" onClick={() => movePair(pair.id, -1)} disabled={idx === 0} title="Move up">↑</Button>
                        <Button variant="ghost" onClick={() => movePair(pair.id, 1)} disabled={idx === pairs.length - 1} title="Move down">↓</Button>
                        <Button variant="danger" onClick={() => removePair(pair.id)} disabled={pairs.length === 1}>Remove</Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <Label>Question</Label>
                        <Textarea placeholder="e.g., What does gain mean and what does it do?" value={pair.q} onChange={(e) => updatePair(pair.id, { q: e.target.value })} />
                      </div>
                      <div>
                        <Label>Answer</Label>
                        <Textarea placeholder="Gain refers to the voltage applied to the detector. If the gain is too low, you won't see photons. If it's too high, you might see more photons..." value={pair.a} onChange={(e) => updatePair(pair.id, { a: e.target.value })} />
                      </div>
                    </div>
                    <div className="mt-3">
                      <Label>Tags (optional)</Label>
                      <Input
                        placeholder="comma,separated,tags  (e.g., syllabus, office-hours, policy)"
                        value={(pair.tags || []).join(",")}
                        onChange={(e) => updatePair(pair.id, { tags: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
                      />
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-between">
                  <Button variant="secondary" onClick={addPair}>+ Add another pair</Button>
                  <Tiny>{pairs.length} pair{pairs.length === 1 ? "" : "s"}</Tiny>
                </div>
              </div>
            </Card>
          </div>
        </div>

        {/* Import modal */}
        {importOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
            <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-lg font-semibold">Import from JSON</h3>
                <Button variant="ghost" onClick={() => setImportOpen(false)}>Close</Button>
              </div>
              <p className="mb-2 text-sm text-gray-600">Paste a previously exported payload, a raw array of Q/A, or JSONL. Trailing commas will be stripped automatically.</p>
              <Textarea ref={importTextAreaRef} value={importText} onChange={(e) => setImportText(e.target.value)} className="min-h-[220px]" />
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button variant="secondary" onClick={handleImportJSON}>Import</Button>
                <Button variant="ghost" onClick={() => setImportOpen(false)}>Cancel</Button>
              </div>
            </div>
          </div>
        )}

        <footer className="mt-10 text-center text-xs text-gray-500">
          <p>Built for UMass labs — works with Ollama + nomic-embed-text. This is a front-end only demo.</p>
        </footer>
      </div>
    </div>
  );
}
