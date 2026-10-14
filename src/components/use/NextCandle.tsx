import type { NextCandleForecast } from "@/lib/use/types";
import { REGIME_LABELS } from "@/lib/use/regime";
import { Chip, Panel, Stat, numFmt, pct } from "./primitives";
import { cn } from "@/lib/utils";

const DIRECTION_LABEL: Record<NextCandleForecast["direction"], string> = {
  BULLISH: "ميل صاعد",
  BEARISH: "ميل هابط",
  NEUTRAL: "بدون ميل واضح",
};

export function NextCandle({ f }: { f: NextCandleForecast }) {
  const tone = f.direction === "BULLISH" ? "bull" : f.direction === "BEARISH" ? "bear" : "neutral";
  return (
    <Panel
      title="الشمعة القادمة"
      subtitle="احتمالات مبنية على بيانات محققة — ليست ادعاءً مؤكداً بالنتيجة."
      action={
        <div className="flex flex-wrap gap-1.5">
          <Chip>{f.timeframe}</Chip>
          <Chip>{REGIME_LABELS[f.regime] ?? f.regime}</Chip>
          {f.overfittingRisk && <Chip tone="warn">OVERFITTING RISK</Chip>}
        </div>
      }
    >
      <div className={cn("num text-2xl", tone === "bull" && "text-bull", tone === "bear" && "text-bear")}>
        {DIRECTION_LABEL[f.direction]}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="احتمال الصعود" value={pct(f.bullishProbability)} tone="bull" />
        <Stat label="احتمال الهبوط" value={pct(f.bearishProbability)} tone="bear" />
        <Stat label="احتمال الحياد" value={pct(f.neutralProbability)} />
        <Stat label="الثقة المعايرة" value={pct(f.confidence)} hint="معايرة من سلوك خارج العينة" />
        <Stat label="العائد المتوقع" value={`${numFmt(f.expectedReturn)}%`} />
        <Stat label="التقلب المتوقع" value={`${numFmt(f.expectedVolatility)}%`} />
        <Stat label="النطاق المتوقع (أدنى)" value={numFmt(f.expectedLow, 4)} />
        <Stat label="النطاق المتوقع (أعلى)" value={numFmt(f.expectedHigh, 4)} />
        <Stat label="سعر المرجع" value={numFmt(f.referenceClose, 4)} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-soft">
        <span>حجم العينة: {f.sampleSize}</span>
        <span>إصدار النموذج: {f.modelVersion}</span>
        <span>آخر بيانات: {new Date(f.dataTimestamp).toLocaleString("ar")}</span>
        <span>جودة البيانات: {f.dataQuality}</span>
      </div>
    </Panel>
  );
}

export function Evidence({ f }: { f: NextCandleForecast }) {
  const max = Math.max(...f.evidence.map((e) => Math.abs(e.contribution)), 1);
  return (
    <Panel title="تفسير التوقع" subtitle="مساهمات النموذج في القرار الحالي (نقاط لوجيت مقيسة)، مع العوامل المعاكسة.">
      <ul className="space-y-2">
        {f.evidence.map((e) => (
          <li key={e.label} className="flex items-center gap-3">
            <span className="w-40 shrink-0 truncate text-[11px] text-ink-soft">{e.label}</span>
            <span className="relative h-2 flex-1 rounded-full bg-muted">
              <span
                className={cn(
                  "absolute inset-y-0 rounded-full",
                  e.contribution >= 0 ? "left-1/2 bg-bull" : "right-1/2 bg-bear",
                )}
                style={{ width: `${(Math.abs(e.contribution) / max) * 50}%` }}
              />
            </span>
            <span className="num w-16 text-left text-xs">
              {e.contribution > 0 ? "+" : ""}
              {e.contribution.toFixed(1)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-ink-soft">
        هذه علاقات إحصائية استخرجها النموذج، وليست إثباتاً لعلاقة سببية.
      </p>
    </Panel>
  );
}

export function ModelQuality({ f }: { f: NextCandleForecast }) {
  const rows: { label: string; m: NextCandleForecast["metrics"]["train"] }[] = [
    { label: "تدريب", m: f.metrics.train },
    { label: "تحقق", m: f.metrics.validation },
    { label: "خارج العينة", m: f.metrics.outOfSample },
    { label: "المرجع البسيط", m: f.metrics.baseline },
  ];
  return (
    <Panel title="أداء النموذج" subtitle="تقسيم زمني 60/20/20 بدون خلط عشوائي، مع مقارنة إلزامية بنموذج مرجعي.">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-right text-xs">
          <thead className="text-ink-soft">
            <tr className="border-b border-glass-border">
              <th className="py-2 font-medium">المجموعة</th>
              <th className="py-2 font-medium">العينات</th>
              <th className="py-2 font-medium">الدقة</th>
              <th className="py-2 font-medium">Log Loss</th>
              <th className="py-2 font-medium">Brier</th>
              <th className="py-2 font-medium">AUC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-glass-border/70 last:border-0">
                <td className="py-2 text-ink">{r.label}</td>
                <td className="num py-2">{r.m.samples}</td>
                <td className="num py-2">{pct(r.m.accuracy)}</td>
                <td className="num py-2">{numFmt(r.m.logLoss, 3)}</td>
                <td className="num py-2">{numFmt(r.m.brier, 3)}</td>
                <td className="num py-2">{numFmt(r.m.auc, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {f.metrics.walkForward.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[11px] text-ink-soft">Walk-Forward (نوافذ متزايدة)</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {f.metrics.walkForward.map((m, i) => (
              <Stat key={i} label={`نافذة ${i + 1}`} value={pct(m.accuracy)} hint={`AUC ${numFmt(m.auc, 2)}`} />
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="نظام السوق الحالي" value={REGIME_LABELS[f.regime] ?? f.regime} />
        <Stat label="عينات نفس النظام" value={String(f.regimeStats.samples)} />
        <Stat label="نسبة النجاح في نفس النظام" value={pct(f.regimeStats.successRate)} />
      </div>
    </Panel>
  );
}
