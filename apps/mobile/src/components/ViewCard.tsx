import React, { useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { MobileClient } from "@ds-bot/mobile-sdk";
import { tr } from "../i18n";
import { errorText } from "../types";
import { useTheme } from "../theme";
import { Button, Field, Notice } from "./UI";
import { AnimatedPressable as Pressable } from "./Motion";
import { MarkdownText } from "./MarkdownText";
import { PendingView, ViewNode, inputValues, resolve, scope, shown } from "../logic/view-model";

export function ViewCard({ pending, sessionId, conversationId, client, refresh, disabled = false }: {
  pending: PendingView; sessionId: string; conversationId: string; client: MobileClient;
  refresh: () => Promise<void>; disabled?: boolean;
}) {
  const t = useTheme();
  const [inputs, setInputs] = useState(() => inputValues(pending.view));
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const names = scope(pending.view, inputs);
  const value = (item: unknown) => resolve(item, names);
  const text = (item: unknown) => shown(value(item));
  const update = (id: string, next: unknown) => setInputs(current => ({ ...current, [id]: next }));
  async function send(action?: string, answer: Record<string, unknown> = {}) {
    if (submitting.current || disabled || settled) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await client.action(action ? "view-reply" : "dismiss-view", {
        conversationId, sessionId, viewId: pending.id,
        ...(action ? { action, values: Object.keys(inputs).length ? { ...answer, inputs } : answer } : {}),
      });
      setSettled(true);
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { submitting.current = false; setBusy(false); }
  }
  function render(node: ViewNode, key: string): React.ReactNode {
    if (!node || typeof node !== "object") return null;
    const label = typeof node.label === "string" ? node.label : "";
    const choices = (Array.isArray(node.options) ? node.options : []).filter(item => typeof item === "string" || (item !== null && typeof item === "object" && typeof item.label === "string")) as Array<string | { label: string; value?: string; description?: string }>;
    const tone = value(node.tone);
    const color = tone === "bad" ? t.error : tone === "good" ? t.accent : t.ink;
    switch (node.type) {
      case "stack": case "row": return <View key={key} style={{ gap: 10, flexDirection: node.type === "row" ? "row" : "column", flexWrap: "wrap" }}>{(Array.isArray(node.children) ? node.children : []).map((child, index) => render(child, `${key}:${index}`))}</View>;
      case "text": case "callout": return <View key={key} style={{ minWidth: 120, flexShrink: 1 }}><MarkdownText text={text(node.text)} /></View>;
      case "metric": return <View key={key} style={{ gap: 4, minWidth: 90 }}><Text style={{ color: t.muted }}>{label}</Text><Text selectable style={{ color, fontSize: 24, fontWeight: "600" }}>{text(node.value)}</Text>{node.caption !== undefined && <Text style={{ color: t.muted }}>{text(node.caption)}</Text>}</View>;
      case "table": {
        const columns = Array.isArray(node.columns) ? node.columns as Array<{ key?: string; label: string }> : [];
        const rows = Array.isArray(node.rows) ? node.rows as unknown[][] : [];
        return <ScrollView key={key} horizontal nestedScrollEnabled accessibilityLabel={tr("Table")}><View style={{ gap: 1 }}>{[columns.map(column => column.label), ...rows.map(row => columns.map((_, index) => text(row[index])))].map((row, index) => <View key={index} style={{ flexDirection: "row", backgroundColor: index ? t.surface : t.hover }}>{row.map((cell, col) => <Text key={col} selectable style={{ width: 110, color: t.ink, padding: 8, fontWeight: index ? "400" : "600" }}>{cell}</Text>)}</View>)}</View></ScrollView>;
      }
      case "chart": {
        const categories = Array.isArray(node.categories) ? node.categories : [];
        const series = Array.isArray(node.series) ? node.series as Array<{ name?: string; values: unknown[] }> : [];
        const values = series.flatMap(item => Array.isArray(item.values) ? item.values.map(entry => Number(value(entry))) : []).filter(Number.isFinite);
        const maximum = Math.max(1, ...values.map(Math.abs));
        const kind = typeof node.kind === "string" ? node.kind : "bar";
        return <View key={key} style={{ gap: 8, minWidth: 180 }} accessibilityLabel={`${tr("Chart")} ${kind}`}>
          {categories.map((category, index) => <View key={index} style={{ gap: 3 }}><Text style={{ color: t.ink }}>{shown(category)}</Text>{series.map((item, seriesIndex) => { const number = Number(value(item.values?.[index])); return <View key={seriesIndex} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Text style={{ color: t.muted, minWidth: 42 }}>{item.name || tr("Series")}</Text><View style={{ width: `${Math.min(100, Math.abs(number) / maximum * 100)}%`, maxWidth: 180, height: 12, borderRadius: 6, backgroundColor: t.accent }} /><Text style={{ color: t.ink }}>{Number.isFinite(number) ? number : "—"}{typeof node.unit === "string" ? ` ${node.unit}` : ""}</Text></View>; })}</View>)}
          {node.caption !== undefined && <Text style={{ color: t.muted }}>{text(node.caption)}</Text>}
        </View>;
      }
      case "progress": {
        const raw = node.percent !== undefined ? Number(value(node.percent)) : Number(value(node.max)) > 0 ? Number(value(node.value)) / Number(value(node.max)) * 100 : 0;
        const percent = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0));
        return <View key={key} style={{ gap: 5, minWidth: 160, flex: 1 }} accessibilityLabel={`${label} ${Math.round(percent)}%`}><Text style={{ color: t.ink }}>{label} · {node.valueLabel !== undefined ? text(node.valueLabel) : `${Math.round(percent)}%`}</Text><View style={{ height: 8, borderRadius: 4, backgroundColor: t.line }}><View style={{ width: `${percent}%`, height: 8, borderRadius: 4, backgroundColor: t.accent }} /></View></View>;
      }
      case "html": return <View key={key} style={{ padding: 10, borderWidth: 1, borderColor: t.line, borderRadius: 10 }}><Text style={{ color: t.ink }}>{typeof node.summary === "string" ? node.summary : tr("HTML content")}</Text><Text selectable style={{ color: t.muted, fontFamily: "monospace" }}>{shown(node.html)}</Text></View>;
      case "sources": return <View key={key} style={{ gap: 4 }}>{(Array.isArray(node.items) ? node.items : []).map((item: { label: string; url: string }, index) => <Text selectable key={index} style={{ color: t.muted }}>{item.label}: {item.url}</Text>)}</View>;
      case "slider": case "number": return <Field key={key} label={`${label}${node.unit ? ` (${node.unit})` : ""}`} keyboardType="numeric" value={String(inputs[node.id ?? ""] ?? "")} editable={!busy && !disabled} onChangeText={raw => { if (raw.trim() && Number.isFinite(Number(raw))) update(node.id!, Number(raw)); }} />;
      case "toggle": return <Button key={key} secondary title={`${label}: ${inputs[node.id ?? ""] ? tr("On") : tr("Off")}`} disabled={busy || disabled} onPress={() => update(node.id!, !inputs[node.id!])} />;
      case "choice": return <View key={key} style={{ gap: 5 }}><Text style={{ color: t.ink }}>{label}</Text>{choices.map((item, index) => { const choice = typeof item === "string" ? item : item.label; const selectedValue = typeof item === "string" ? item : item.value ?? item.label; return <Button key={index} secondary title={`${inputs[node.id!] === selectedValue ? "✓ " : ""}${choice}`} disabled={busy || disabled} onPress={() => update(node.id!, selectedValue)} />; })}</View>;
      case "options": return <View key={key} style={{ gap: 7 }}>{choices.map((option, index) => { const optionLabel = typeof option === "string" ? option : option.label; const picked = selected[node.id!] ?? []; const checked = picked.includes(optionLabel); return <Pressable key={index} accessibilityRole={node.multi ? "checkbox" : "button"} accessibilityState={{ checked: node.multi ? checked : undefined, disabled: busy || disabled }} disabled={busy || disabled} onPress={() => node.multi ? setSelected(current => ({ ...current, [node.id!]: checked ? picked.filter(item => item !== optionLabel) : [...picked, optionLabel] })) : void send(node.id, { selected: [optionLabel] })} style={{ minHeight: 44, justifyContent: "center", padding: 10, borderWidth: 1, borderRadius: 10, borderColor: checked ? t.accent : t.line }}><Text style={{ color: t.ink }}>{checked ? "✓ " : ""}{optionLabel}</Text>{typeof option === "object" && option.description ? <Text style={{ color: t.muted }}>{String(option.description)}</Text> : null}</Pressable>; })}{node.multi === true && <Button title={tr("Submit")} disabled={!selected[node.id!]?.length || busy || disabled} onPress={() => void send(node.id, { selected: selected[node.id!] })} />}</View>;
      case "confirm": return <View key={key} style={{ flexDirection: "row", gap: 8 }}><Button secondary title={typeof node.cancelLabel === "string" ? node.cancelLabel : tr("Cancel")} disabled={busy || disabled} onPress={() => void send(node.id, { confirmed: false })}/><Button title={typeof node.confirmLabel === "string" ? node.confirmLabel : tr("Confirm")} disabled={busy || disabled} onPress={() => void send(node.id, { confirmed: true })}/></View>;
      case "form": { const form = Array.isArray(node.fields) ? node.fields as Array<{ id: string; label: string; placeholder?: string }> : []; return <View key={key} style={{ gap: 10 }}>{form.map(field => <Field key={field.id} label={field.label} placeholder={field.placeholder} value={fields[field.id] ?? ""} editable={!busy && !disabled} onChangeText={next => setFields(previous => ({ ...previous, [field.id]: next }))}/>)}<Button title={typeof node.submitLabel === "string" ? node.submitLabel : tr("Submit")} disabled={busy || disabled} onPress={() => void send(node.id, { fields: Object.fromEntries(form.map(field => [field.id, fields[field.id] ?? ""])) })}/></View>; }
      case "submit": return <Button key={key} title={label || tr("Send")} disabled={busy || disabled} onPress={() => void send(node.id)} />;
      default: return null;
    }
  }
  if (settled) return null;
  return <View style={{ backgroundColor: t.bubble, borderRadius: 16, padding: 12, marginVertical: 8, gap: 12 }} accessibilityRole="summary">
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}><Text style={{ color: t.ink, fontWeight: "600", fontSize: 15, flex: 1 }}>{pending.title || tr("View")}</Text><Button secondary compact title={tr("Dismiss")} disabled={busy || disabled} onPress={() => void send()} /></View>
    {render(pending.view, "view")}
    <Notice error text={error}/>
  </View>;
}
