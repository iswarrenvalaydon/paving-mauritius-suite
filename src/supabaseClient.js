import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://hpmmyateiscpvvgkanhf.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_pa-68ymQdePnWN20IfES_A_zVh4ljqy";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
