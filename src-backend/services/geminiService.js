// Servicio de IA de Google (Gemini) para clasificar el sentimiento de las reseñas.
//
// La clave se lee de process.env.GEMINI_API_KEY (la misma que usa el Chat Agent IA,
// ver .env.example). Sin clave, isConfigured() devuelve false y el panel sigue
// funcionando con el fallback por valoración (★>=7 positiva, ★<=4 negativa).
//
// Se usa el endpoint REST nativo de Gemini (generateContent) con salida JSON
// forzada; no requiere paquetes adicionales (usa fetch de Node >= 18).
"use strict";

const API_KEY = (process.env.GEMINI_API_KEY || "").trim();
// Modelo preferente para clasificación: GEMINI_MODEL > CHAT_MODEL > gemini-3.8-flash.
const MODEL =
    (process.env.GEMINI_MODEL || "").trim() ||
    (process.env.CHAT_MODEL || "").trim() ||
    "gemini-3.8-flash";

const BATCH_SIZE = 40;          // reseñas por llamada a la API
const TIMEOUT_MS = 60000;       // timeout por llamada
const MAX_REVIEWS = 300;        // tope de seguridad por petición

function isConfigured() {
    return Boolean(API_KEY);
}

function normalizeLabel(value) {
    const v = String(value || "").trim().toLowerCase();
    if (v === "positive" || v === "positiva" || v === "positivo") return "positive";
    if (v === "negative" || v === "negativa" || v === "negativo") return "negative";
    if (v === "neutral" || v === "neutra" || v === "neutro" || v === "mixta" || v === "mixto") return "neutral";
    return null;
}

// Códigos de estado que conviene reintentar (saturación temporal de la API).
function isRetriable(status) {
    return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function generateContent(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
    // Espera (en ms) ANTES de cada intento: sin espera el primero, luego 1.5s y 4s.
    const backoff = [0, 1500, 4000];
    let lastError = null;

    for (let attempt = 0; attempt < backoff.length; attempt++) {
        if (backoff[attempt] > 0) await new Promise((r) => setTimeout(r, backoff[attempt]));

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": API_KEY
                },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0, responseMimeType: "application/json" }
                }),
                signal: controller.signal
            });
            if (res.ok) return await res.json();

            const body = await res.text().catch(() => "");
            lastError = `HTTP ${res.status}`;
            console.error(`[geminiService] HTTP ${res.status} (${MODEL}): ${String(body).slice(0, 200)}`);
            if (!isRetriable(res.status)) return null; // error permanente (clave, modelo...)
            // Error transitorio: reintentar.
        } catch (error) {
            lastError = error.message || String(error);
            console.error(`[geminiService] Error llamando a Gemini (intento ${attempt + 1}/${backoff.length}): ${error.message}`);
            // Timeout (abort) o fallo de red: reintentar.
        } finally {
            clearTimeout(timer);
        }
    }
    console.error(`[geminiService] Sin éxito tras ${backoff.length} intentos: ${lastError}`);
    return null;
}

// Extrae el array de etiquetas de la respuesta JSON del modelo.
function extractLabels(data, expected) {
    try {
        const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
        const text = (parts || []).map((p) => p.text || "").join("");
        const cleaned = String(text)
            .trim()
            .replace(/^```(?:json)?/i, "")
            .replace(/```$/i, "")
            .trim();
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (!match) return null;
        const arr = JSON.parse(match[0]);
        if (!Array.isArray(arr) || arr.length === 0) return null;
        const labels = arr.slice(0, expected).map((item) =>
            typeof item === "string" ? normalizeLabel(item) : normalizeLabel(item && (item.sentiment || item.label))
        );
        return labels.some(Boolean) ? labels : null;
    } catch (e) {
        return null;
    }
}

/**
 * Clasifica el tono de N textos (reseñas) como "positive" | "neutral" | "negative".
 * Devuelve un array con una etiqueta por texto, en el mismo orden de entrada.
 * Si no hay clave configurada o falla Gemini, devuelve null (el caller usa fallback).
 * @param {string[]} texts
 * @returns {Promise<string[]|null>}
 */
async function classifyTexts(texts) {
    if (!isConfigured()) return null;
    const items = (Array.isArray(texts) ? texts : [])
        .map((t) => String(t || "").replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 0)
        .slice(0, MAX_REVIEWS);
    if (items.length === 0) return [];

    const out = new Array(items.length).fill(null);
    let offset = 0;
    while (offset < items.length) {
        const batch = items.slice(offset, offset + BATCH_SIZE);
        const numbered = batch.map((t, idx) => `${offset + idx + 1}. ${t}`);
        const prompt = [
            "Eres un analizador de sentimiento profesional para reseñas de películas y series escritas en español.",
            "Clasifica el TONO de cada reseña como positivo, neutral o negativo, basándote en el texto (opinión, argumentos, vocabulario y tono general), no solo en la puntuación numérica.",
            "Devuelve ÚNICAMENTE un array JSON con un objeto por reseña, en el MISMO ORDEN y sin texto adicional, con esta forma exacta:",
            '[{"sentiment":"positive"},{"sentiment":"neutral"},{"sentiment":"negative"}]',
            "",
            "Reseñas a clasificar (numeradas en el mismo orden):",
            numbered.join("\n")
        ].join("\n");

        const data = await generateContent(prompt);
        const labels = extractLabels(data, batch.length);
        if (labels) {
            labels.forEach((label, j) => {
                if (label) out[offset + j] = label;
            });
        }
        // Si el lote falló por completo, out[offset..offset+batch.length] queda null:
        // el caller decide si reintentar (el backfill lo hace en la siguiente pasada).
        offset += batch.length;
        // Pequeña pausa para no saturar la cuota gratuita en trabajos grandes.
        if (offset % 200 === 0) await new Promise((r) => setTimeout(r, 300));
    }
    return out;
}

module.exports = { isConfigured, classifyTexts, normalizeLabel };