import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".backtrack");
const MTTR_FILE = path.join(DATA_DIR, "mttr-log.json");
const DETECTION_FILE = path.join(DATA_DIR, "detection-log.json");
const EVAL_FILE = path.join(DATA_DIR, "evaluations.json");

export type MttrEntry = {
  id: string;
  service: string;
  connectionId?: string;
  anomaly_type: "TSD" | "LSI" | "BOTH" | "MANUAL" | "AUTO";
  anomaly_detected_at: string;
  rollback_triggered_at: string;
  rollback_completed_at: string;
  mttr_seconds: number;
  success: boolean;
  source?: "manual" | "agent";
};

export type DetectionEntry = {
  id: string;
  test_label: string;
  fault_injected: boolean;
  fault_type: "crash" | "latency" | "logs" | "none";
  service?: string;
  injected_at: string | null;
  tsd_detected: boolean;
  lsi_detected: boolean;
  detected_at: string | null;
  detection_latency_seconds: number | null;
  notes: string;
  created_at: string;
};

export type EvalScores = {
  functional_suitability: { completeness: number; correctness: number; appropriateness: number };
  performance_efficiency: { time_behavior: number; resource_utilization: number };
  compatibility: { coexistence: number; interoperability: number };
  usability: { recognisability: number; learnability: number; operability: number; user_error_protection: number; ui_aesthetics: number };
  reliability: { maturity: number; availability: number; fault_tolerance: number; recoverability: number };
  security: { confidentiality: number; integrity: number; authenticity: number };
  maintainability: { modularity: number; reusability: number; analysability: number; testability: number };
  portability: { adaptability: number; installability: number };
};

export type EvaluationEntry = {
  id: string;
  respondent: string;
  role: string;
  submitted_at: string;
  scores: EvalScores;
  comments: string;
};

function readFile<T>(filePath: string): T[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeFile<T>(filePath: string, data: T[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function listMttrEntries(): MttrEntry[] {
  return readFile<MttrEntry>(MTTR_FILE);
}

export function addMttrEntry(entry: Omit<MttrEntry, "id">): MttrEntry {
  const entries = listMttrEntries();
  const newEntry: MttrEntry = { id: crypto.randomUUID(), ...entry };
  entries.push(newEntry);
  writeFile(MTTR_FILE, entries);
  return newEntry;
}

export function clearMttrEntries() {
  writeFile(MTTR_FILE, []);
}

export function listDetectionEntries(): DetectionEntry[] {
  return readFile<DetectionEntry>(DETECTION_FILE);
}

export function addDetectionEntry(
  entry: Omit<DetectionEntry, "id" | "created_at">,
): DetectionEntry {
  const entries = listDetectionEntries();
  const newEntry: DetectionEntry = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    ...entry,
  };
  entries.push(newEntry);
  writeFile(DETECTION_FILE, entries);
  return newEntry;
}

export function clearDetectionEntries() {
  writeFile(DETECTION_FILE, []);
}

export function listEvaluations(): EvaluationEntry[] {
  return readFile<EvaluationEntry>(EVAL_FILE);
}

export function addEvaluation(
  entry: Omit<EvaluationEntry, "id" | "submitted_at">,
): EvaluationEntry {
  const entries = listEvaluations();
  const newEntry: EvaluationEntry = {
    id: crypto.randomUUID(),
    submitted_at: new Date().toISOString(),
    ...entry,
  };
  entries.push(newEntry);
  writeFile(EVAL_FILE, entries);
  return newEntry;
}
