import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const fetchCoverage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({
      symbol: z.string(),
      timeframe: z.string(),
      days: z.number().min(1).max(365),
      provider: z.string().optional(),
      // Optional explicit instrument for provider tests (e.g. Databento "GC.c.0").
      providerSymbol: z.string().optional(),
      market: z.enum(["crypto", "forex", "metal", "futures", "stock"]).optional(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { fetchHistorical } = await import("./data/providers.server");
    const { listSymbols, marketOf } = await import("./market-data.server");
    const sym = (await listSymbols()).find((s) => s.symbol === data.symbol);
    if (!sym && !data.providerSymbol) throw new Error("رمز غير معروف");
    const end = Date.now();
    const { coverage } = await fetchHistorical(
      {
        symbol: data.symbol,
        providerSymbol: data.providerSymbol ?? sym!.provider_symbol,
        market: data.market ?? marketOf(sym!),
        timeframe: data.timeframe,
        start: end - data.days * 86_400_000,
        end,
      },
      data.provider || undefined,
    );
    return coverage;
  });

export const getProviderHealth = createServerFn({ method: "GET" }).handler(async () => {
  const { providerStatus } = await import("./data/providers.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: health }, { data: fetches }] = await Promise.all([
    supabaseAdmin.from("use_provider_health").select("*"),
    supabaseAdmin.from("use_data_fetches").select("id,created_at,symbol,timeframe,requested_provider,actual_provider,status").order("created_at", { ascending: false }).limit(15),
  ]);
  return {
    providers: providerStatus().map((p) => ({ ...p, health: (health ?? []).find((h) => h.provider === p.id) ?? null })),
    fetches: fetches ?? [],
  };
});

export const checkDatabento = createServerFn({ method: "POST" }).handler(async () => {
  const { probeDatabento } = await import("./data/providers.server");
  return probeDatabento();
});
