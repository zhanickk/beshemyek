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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      bot_sends: {
        Row: {
          content: string | null
          id: string
          kind: string
          meta: Json | null
          sent_at: string
          telegram_chat_id: number
        }
        Insert: {
          content?: string | null
          id?: string
          kind: string
          meta?: Json | null
          sent_at?: string
          telegram_chat_id: number
        }
        Update: {
          content?: string | null
          id?: string
          kind?: string
          meta?: Json | null
          sent_at?: string
          telegram_chat_id?: number
        }
        Relationships: []
      }
      bot_settings: {
        Row: {
          ai_replies_enabled: boolean
          chat_id: string
          id: string
          language: string
          polls_enabled: boolean
          prompt_frequency: string
          prompt_hour_utc: number
          prompts_enabled: boolean
          quiet_end: number | null
          quiet_start: number | null
          tone: string
          updated_at: string
        }
        Insert: {
          ai_replies_enabled?: boolean
          chat_id: string
          id?: string
          language?: string
          polls_enabled?: boolean
          prompt_frequency?: string
          prompt_hour_utc?: number
          prompts_enabled?: boolean
          quiet_end?: number | null
          quiet_start?: number | null
          tone?: string
          updated_at?: string
        }
        Update: {
          ai_replies_enabled?: boolean
          chat_id?: string
          id?: string
          language?: string
          polls_enabled?: boolean
          prompt_frequency?: string
          prompt_hour_utc?: number
          prompts_enabled?: boolean
          quiet_end?: number | null
          quiet_start?: number | null
          tone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_settings_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: true
            referencedRelation: "chats"
            referencedColumns: ["id"]
          },
        ]
      }
      chats: {
        Row: {
          chat_type: string | null
          id: string
          is_active: boolean
          joined_at: string
          telegram_chat_id: number
          title: string | null
          updated_at: string
        }
        Insert: {
          chat_type?: string | null
          id?: string
          is_active?: boolean
          joined_at?: string
          telegram_chat_id: number
          title?: string | null
          updated_at?: string
        }
        Update: {
          chat_type?: string | null
          id?: string
          is_active?: boolean
          joined_at?: string
          telegram_chat_id?: number
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      messages_log: {
        Row: {
          created_at: string
          from_user_id: number | null
          from_username: string | null
          kind: string
          raw: Json
          telegram_chat_id: number
          text: string | null
          update_id: number
        }
        Insert: {
          created_at?: string
          from_user_id?: number | null
          from_username?: string | null
          kind?: string
          raw: Json
          telegram_chat_id: number
          text?: string | null
          update_id: number
        }
        Update: {
          created_at?: string
          from_user_id?: number | null
          from_username?: string | null
          kind?: string
          raw?: Json
          telegram_chat_id?: number
          text?: string | null
          update_id?: number
        }
        Relationships: []
      }
      polls: {
        Row: {
          closed_at: string | null
          correct_option: number | null
          id: string
          is_closed: boolean
          kind: string
          options: Json
          question: string
          started_at: string
          telegram_chat_id: number
          telegram_message_id: number | null
          telegram_poll_id: string | null
        }
        Insert: {
          closed_at?: string | null
          correct_option?: number | null
          id?: string
          is_closed?: boolean
          kind?: string
          options: Json
          question: string
          started_at?: string
          telegram_chat_id: number
          telegram_message_id?: number | null
          telegram_poll_id?: string | null
        }
        Update: {
          closed_at?: string | null
          correct_option?: number | null
          id?: string
          is_closed?: boolean
          kind?: string
          options?: Json
          question?: string
          started_at?: string
          telegram_chat_id?: number
          telegram_message_id?: number | null
          telegram_poll_id?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
        }
        Relationships: []
      }
      prompts: {
        Row: {
          category: string
          created_at: string
          id: string
          is_active: boolean
          language: string
          text: string
        }
        Insert: {
          category?: string
          created_at?: string
          id?: string
          is_active?: boolean
          language?: string
          text: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          is_active?: boolean
          language?: string
          text?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "user"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const
