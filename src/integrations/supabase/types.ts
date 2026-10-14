export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  public: {
    Tables: {
      use_analysis_runs: {
        Row: {
          analysis_id: string
          created_at: string
          dataset_hash: string | null
          id: string
          period_end: string | null
          period_start: string | null
          provider: string | null
          report: Json
          status: string
          strategy_hash: string
          strategy_id: string | null
          symbol: string
          timeframe: string
        }
        Insert: {
          analysis_id?: string
          created_at?: string
          dataset_hash?: string | null
          id?: string
          period_end?: string | null
          period_start?: string | null
          provider?: string | null
          report?: Json
          status: string
          strategy_hash: string
          strategy_id?: string | null
          symbol: string
          timeframe: string
        }
        Update: {
          analysis_id?: string
          created_at?: string
          dataset_hash?: string | null
          id?: string
          period_end?: string | null
          period_start?: string | null
          provider?: string | null
          report?: Json
          status?: string
          strategy_hash?: string
          strategy_id?: string | null
          symbol?: string
          timeframe?: string
        }
        Relationships: [
          {
            foreignKeyName: "use_analysis_runs_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "use_strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      use_backtest_runs: {
        Row: {
          analysis_id: string
          bar_count: number
          breakdowns: Json
          coverage_percent: number | null
          coverage_report_id: string | null
          coverage_status: string | null
          created_at: string
          dataset: string | null
          dataset_hash: string | null
          error: string | null
          id: string
          ir: Json | null
          metrics: Json
          period_end: string
          period_start: string
          provider: string | null
          settings: Json
          source_language: string
          status: string
          strategy_hash: string
          strategy_id: string | null
          strategy_version: number | null
          symbol: string
          timeframe: string
          trades: Json
          trades_hash: string | null
        }
        Insert: {
          analysis_id?: string
          bar_count?: number
          breakdowns?: Json
          coverage_percent?: number | null
          coverage_report_id?: string | null
          coverage_status?: string | null
          created_at?: string
          dataset?: string | null
          dataset_hash?: string | null
          error?: string | null
          id?: string
          ir?: Json | null
          metrics?: Json
          period_end: string
          period_start: string
          provider?: string | null
          settings?: Json
          source_language: string
          status?: string
          strategy_hash: string
          strategy_id?: string | null
          strategy_version?: number | null
          symbol: string
          timeframe: string
          trades?: Json
          trades_hash?: string | null
        }
        Update: {
          analysis_id?: string
          bar_count?: number
          breakdowns?: Json
          coverage_percent?: number | null
          coverage_report_id?: string | null
          coverage_status?: string | null
          created_at?: string
          dataset?: string | null
          dataset_hash?: string | null
          error?: string | null
          id?: string
          ir?: Json | null
          metrics?: Json
          period_end?: string
          period_start?: string
          provider?: string | null
          settings?: Json
          source_language?: string
          status?: string
          strategy_hash?: string
          strategy_id?: string | null
          strategy_version?: number | null
          symbol?: string
          timeframe?: string
          trades?: Json
          trades_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "use_backtest_runs_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "use_strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      use_backtests: {
        Row: {
          created_at: string
          id: string
          patterns: Json
          period_end: string | null
          period_start: string | null
          sample_size: number
          split: string
          stats: Json
          strategy_id: string | null
          symbol: string
          timeframe: string
        }
        Insert: {
          created_at?: string
          id?: string
          patterns?: Json
          period_end?: string | null
          period_start?: string | null
          sample_size?: number
          split?: string
          stats?: Json
          strategy_id?: string | null
          symbol: string
          timeframe: string
        }
        Update: {
          created_at?: string
          id?: string
          patterns?: Json
          period_end?: string | null
          period_start?: string | null
          sample_size?: number
          split?: string
          stats?: Json
          strategy_id?: string | null
          symbol?: string
          timeframe?: string
        }
        Relationships: [
          {
            foreignKeyName: "use_backtests_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "use_strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      use_candles: {
        Row: {
          close: number
          high: number
          inserted_at: string
          instrument_id: number | null
          low: number
          open: number
          source: string
          symbol: string
          timeframe: string
          ts: string
          volume: number | null
        }
        Insert: {
          close: number
          high: number
          inserted_at?: string
          instrument_id?: number | null
          low: number
          open: number
          source?: string
          symbol: string
          timeframe: string
          ts: string
          volume?: number | null
        }
        Update: {
          close?: number
          high?: number
          inserted_at?: string
          instrument_id?: number | null
          low?: number
          open?: number
          source?: string
          symbol?: string
          timeframe?: string
          ts?: string
          volume?: number | null
        }
        Relationships: []
      }
      use_chat_messages: {
        Row: {
          created_at: string
          id: string
          parts: Json
          role: string
          sdk_id: string
          thread_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          parts?: Json
          role: string
          sdk_id: string
          thread_id: string
        }
        Update: {
          created_at?: string
          id?: string
          parts?: Json
          role?: string
          sdk_id?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "use_chat_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "use_chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      use_chat_threads: {
        Row: {
          created_at: string
          id: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      use_data_fetches: {
        Row: {
          actual_provider: string | null
          coverage: Json
          created_at: string
          id: string
          requested_provider: string
          status: string
          symbol: string
          timeframe: string
        }
        Insert: {
          actual_provider?: string | null
          coverage?: Json
          created_at?: string
          id?: string
          requested_provider: string
          status: string
          symbol: string
          timeframe: string
        }
        Update: {
          actual_provider?: string | null
          coverage?: Json
          created_at?: string
          id?: string
          requested_provider?: string
          status?: string
          symbol?: string
          timeframe?: string
        }
        Relationships: []
      }
      use_forecast_schedules: {
        Row: {
          created_at: string
          enabled: boolean
          fail_count: number
          id: string
          last_error: string | null
          last_run_at: string | null
          last_status: string | null
          last_target_ts: string | null
          min_confidence: number
          next_retry_at: string | null
          strategy_id: string | null
          symbol: string
          timeframe: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          fail_count?: number
          id?: string
          last_error?: string | null
          last_run_at?: string | null
          last_status?: string | null
          last_target_ts?: string | null
          min_confidence?: number
          next_retry_at?: string | null
          strategy_id?: string | null
          symbol: string
          timeframe: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          fail_count?: number
          id?: string
          last_error?: string | null
          last_run_at?: string | null
          last_status?: string | null
          last_target_ts?: string | null
          min_confidence?: number
          next_retry_at?: string | null
          strategy_id?: string | null
          symbol?: string
          timeframe?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "use_forecast_schedules_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "use_strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      use_jobs: {
        Row: {
          attempts: number
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          kind: string
          lease_until: string | null
          payload: Json
          progress: number
          result: Json | null
          started_at: string | null
          status: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          kind: string
          lease_until?: string | null
          payload?: Json
          progress?: number
          result?: Json | null
          started_at?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          kind?: string
          lease_until?: string | null
          payload?: Json
          progress?: number
          result?: Json | null
          started_at?: string | null
          status?: string
        }
        Relationships: []
      }
      use_models: {
        Row: {
          algorithm: string
          baseline_metrics: Json
          calibration: Json
          created_at: string
          feature_importance: Json
          feature_names: string[]
          id: string
          model_version: string
          notes: string | null
          oos_metrics: Json
          overfitting_risk: boolean
          published_at: string | null
          sample_size: number
          status: string
          strategy_id: string | null
          symbol: string
          timeframe: string
          train_metrics: Json
          validation_metrics: Json
          weights: Json
        }
        Insert: {
          algorithm?: string
          baseline_metrics?: Json
          calibration?: Json
          created_at?: string
          feature_importance?: Json
          feature_names?: string[]
          id?: string
          model_version: string
          notes?: string | null
          oos_metrics?: Json
          overfitting_risk?: boolean
          published_at?: string | null
          sample_size?: number
          status?: string
          strategy_id?: string | null
          symbol: string
          timeframe: string
          train_metrics?: Json
          validation_metrics?: Json
          weights?: Json
        }
        Update: {
          algorithm?: string
          baseline_metrics?: Json
          calibration?: Json
          created_at?: string
          feature_importance?: Json
          feature_names?: string[]
          id?: string
          model_version?: string
          notes?: string | null
          oos_metrics?: Json
          overfitting_risk?: boolean
          published_at?: string | null
          sample_size?: number
          status?: string
          strategy_id?: string | null
          symbol?: string
          timeframe?: string
          train_metrics?: Json
          validation_metrics?: Json
          weights?: Json
        }
        Relationships: [
          {
            foreignKeyName: "use_models_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "use_strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      use_nc_models: {
        Row: {
          created_at: string
          data_range: Json | null
          health: Json | null
          id: string
          indicator_hash: string
          model_version: string
          promoted_at: string | null
          report: Json
          retired_at: string | null
          status: string
          symbol: string
          timeframe: string
          was_verified: boolean
        }
        Insert: {
          created_at?: string
          data_range?: Json | null
          health?: Json | null
          id?: string
          indicator_hash: string
          model_version: string
          promoted_at?: string | null
          report: Json
          retired_at?: string | null
          status?: string
          symbol: string
          timeframe: string
          was_verified?: boolean
        }
        Update: {
          created_at?: string
          data_range?: Json | null
          health?: Json | null
          id?: string
          indicator_hash?: string
          model_version?: string
          promoted_at?: string | null
          report?: Json
          retired_at?: string | null
          status?: string
          symbol?: string
          timeframe?: string
          was_verified?: boolean
        }
        Relationships: []
      }
      use_predictions: {
        Row: {
          actual_close: number | null
          actual_move: number | null
          actual_open: number | null
          actual_result: string | null
          atr_threshold: number | null
          bearish_probability: number
          bullish_probability: number
          calibrated_confidence: number | null
          confidence: number
          correct: boolean | null
          created_at: string
          data_quality: string
          direction: string
          evaluated_at: string | null
          evaluation_status: string
          evidence: Json
          expected_high: number | null
          expected_low: number | null
          expected_return: number | null
          expected_volatility: number | null
          explain: Json | null
          feature_version: string | null
          gate: Json | null
          generated_by: string | null
          generation_delay_ms: number | null
          id: string
          indicator_hash: string
          input_data_version: string | null
          market_regime: string | null
          min_confidence: number | null
          mode: string
          model_version: string
          nc_model_id: string | null
          neutral_probability: number
          next_score_at: string | null
          prediction_time: string | null
          provider: string | null
          reference_close: number | null
          sample_size: number
          score_attempts: number
          score_error: string | null
          scored_at: string | null
          scoring_status: string
          session: string | null
          signal: string | null
          source_bar_time: string | null
          strategy_id: string | null
          strategy_version: number | null
          symbol: string
          target_ts: string | null
          timeframe: string
        }
        Insert: {
          actual_close?: number | null
          actual_move?: number | null
          actual_open?: number | null
          actual_result?: string | null
          atr_threshold?: number | null
          bearish_probability: number
          bullish_probability: number
          calibrated_confidence?: number | null
          confidence: number
          correct?: boolean | null
          created_at?: string
          data_quality?: string
          direction: string
          evaluated_at?: string | null
          evaluation_status?: string
          evidence?: Json
          expected_high?: number | null
          expected_low?: number | null
          expected_return?: number | null
          expected_volatility?: number | null
          explain?: Json | null
          feature_version?: string | null
          gate?: Json | null
          generated_by?: string | null
          generation_delay_ms?: number | null
          id?: string
          indicator_hash?: string
          input_data_version?: string | null
          market_regime?: string | null
          min_confidence?: number | null
          mode?: string
          model_version: string
          nc_model_id?: string | null
          neutral_probability: number
          next_score_at?: string | null
          prediction_time?: string | null
          provider?: string | null
          reference_close?: number | null
          sample_size?: number
          score_attempts?: number
          score_error?: string | null
          scored_at?: string | null
          scoring_status?: string
          session?: string | null
          signal?: string | null
          source_bar_time?: string | null
          strategy_id?: string | null
          strategy_version?: number | null
          symbol: string
          target_ts?: string | null
          timeframe: string
        }
        Update: {
          actual_close?: number | null
          actual_move?: number | null
          actual_open?: number | null
          actual_result?: string | null
          atr_threshold?: number | null
          bearish_probability?: number
          bullish_probability?: number
          calibrated_confidence?: number | null
          confidence?: number
          correct?: boolean | null
          created_at?: string
          data_quality?: string
          direction?: string
          evaluated_at?: string | null
          evaluation_status?: string
          evidence?: Json
          expected_high?: number | null
          expected_low?: number | null
          expected_return?: number | null
          expected_volatility?: number | null
          explain?: Json | null
          feature_version?: string | null
          gate?: Json | null
          generated_by?: string | null
          generation_delay_ms?: number | null
          id?: string
          indicator_hash?: string
          input_data_version?: string | null
          market_regime?: string | null
          min_confidence?: number | null
          mode?: string
          model_version?: string
          nc_model_id?: string | null
          neutral_probability?: number
          next_score_at?: string | null
          prediction_time?: string | null
          provider?: string | null
          reference_close?: number | null
          sample_size?: number
          score_attempts?: number
          score_error?: string | null
          scored_at?: string | null
          scoring_status?: string
          session?: string | null
          signal?: string | null
          source_bar_time?: string | null
          strategy_id?: string | null
          strategy_version?: number | null
          symbol?: string
          target_ts?: string | null
          timeframe?: string
        }
        Relationships: [
          {
            foreignKeyName: "use_predictions_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "use_strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      use_provider_failures: {
        Row: {
          classification: string
          created_at: string
          endpoint: string
          http_status: number | null
          id: string
          method: string
          outbound_ip: string | null
          provider: string
          response_body: string | null
          response_headers: Json | null
          server_region: string | null
          source: string | null
          weight_headers: Json | null
        }
        Insert: {
          classification: string
          created_at?: string
          endpoint: string
          http_status?: number | null
          id?: string
          method?: string
          outbound_ip?: string | null
          provider: string
          response_body?: string | null
          response_headers?: Json | null
          server_region?: string | null
          source?: string | null
          weight_headers?: Json | null
        }
        Update: {
          classification?: string
          created_at?: string
          endpoint?: string
          http_status?: number | null
          id?: string
          method?: string
          outbound_ip?: string | null
          provider?: string
          response_body?: string | null
          response_headers?: Json | null
          server_region?: string | null
          source?: string | null
          weight_headers?: Json | null
        }
        Relationships: []
      }
      use_provider_health: {
        Row: {
          blocked_until: string | null
          configured: boolean
          consecutive_blocks: number
          degraded: boolean
          degraded_reason: string | null
          failure_count: number
          last_error: string | null
          last_failure_at: string | null
          last_http_status: number | null
          last_latency_ms: number | null
          last_probe: Json | null
          last_status: string | null
          last_success_at: string | null
          provider: string
          rate_limit_state: string
          request_count: number
          success_count: number
          updated_at: string
        }
        Insert: {
          blocked_until?: string | null
          configured?: boolean
          consecutive_blocks?: number
          degraded?: boolean
          degraded_reason?: string | null
          failure_count?: number
          last_error?: string | null
          last_failure_at?: string | null
          last_http_status?: number | null
          last_latency_ms?: number | null
          last_probe?: Json | null
          last_status?: string | null
          last_success_at?: string | null
          provider: string
          rate_limit_state?: string
          request_count?: number
          success_count?: number
          updated_at?: string
        }
        Update: {
          blocked_until?: string | null
          configured?: boolean
          consecutive_blocks?: number
          degraded?: boolean
          degraded_reason?: string | null
          failure_count?: number
          last_error?: string | null
          last_failure_at?: string | null
          last_http_status?: number | null
          last_latency_ms?: number | null
          last_probe?: Json | null
          last_status?: string | null
          last_success_at?: string | null
          provider?: string
          rate_limit_state?: string
          request_count?: number
          success_count?: number
          updated_at?: string
        }
        Relationships: []
      }
      use_strategies: {
        Row: {
          code: string
          conversion: Json | null
          created_at: string
          description: string | null
          enabled: boolean
          generated_strategy_hash: string | null
          id: string
          language: string
          name: string
          params: Json
          parent_indicator_id: string | null
          representation: Json | null
          source_indicator_hash: string | null
          status: string
          symbols: string[]
          timeframes: string[]
          updated_at: string
          validation: Json | null
          version: number
        }
        Insert: {
          code?: string
          conversion?: Json | null
          created_at?: string
          description?: string | null
          enabled?: boolean
          generated_strategy_hash?: string | null
          id?: string
          language?: string
          name: string
          params?: Json
          parent_indicator_id?: string | null
          representation?: Json | null
          source_indicator_hash?: string | null
          status?: string
          symbols?: string[]
          timeframes?: string[]
          updated_at?: string
          validation?: Json | null
          version?: number
        }
        Update: {
          code?: string
          conversion?: Json | null
          created_at?: string
          description?: string | null
          enabled?: boolean
          generated_strategy_hash?: string | null
          id?: string
          language?: string
          name?: string
          params?: Json
          parent_indicator_id?: string | null
          representation?: Json | null
          source_indicator_hash?: string | null
          status?: string
          symbols?: string[]
          timeframes?: string[]
          updated_at?: string
          validation?: Json | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "use_strategies_parent_indicator_id_fkey"
            columns: ["parent_indicator_id"]
            isOneToOne: false
            referencedRelation: "use_strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      use_symbols: {
        Row: {
          asset_class: string
          canonical_symbol: string | null
          category: string
          created_at: string
          dataset: string | null
          display_name: string
          enabled: boolean
          exchange: string | null
          id: string
          market_type: string
          provider: string
          provider_symbol: string
          status: string
          status_detail: string | null
          supported_timeframes: string[]
          symbol: string
          synced_at: string | null
        }
        Insert: {
          asset_class?: string
          canonical_symbol?: string | null
          category?: string
          created_at?: string
          dataset?: string | null
          display_name: string
          enabled?: boolean
          exchange?: string | null
          id?: string
          market_type?: string
          provider?: string
          provider_symbol: string
          status?: string
          status_detail?: string | null
          supported_timeframes?: string[]
          symbol: string
          synced_at?: string | null
        }
        Update: {
          asset_class?: string
          canonical_symbol?: string | null
          category?: string
          created_at?: string
          dataset?: string | null
          display_name?: string
          enabled?: boolean
          exchange?: string | null
          id?: string
          market_type?: string
          provider?: string
          provider_symbol?: string
          status?: string
          status_detail?: string | null
          supported_timeframes?: string[]
          symbol?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      use_worker_state: {
        Row: {
          last_tick_at: string | null
          last_tick_result: Json | null
          lease_until: string | null
          name: string
          token: string
          updated_at: string
        }
        Insert: {
          last_tick_at?: string | null
          last_tick_result?: Json | null
          lease_until?: string | null
          name: string
          token?: string
          updated_at?: string
        }
        Update: {
          last_tick_at?: string | null
          last_tick_result?: Json | null
          lease_until?: string | null
          name?: string
          token?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
