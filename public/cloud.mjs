// This file is bundled locally. No CDN scripts and no secret/service keys in the browser.
import {createClient} from '@supabase/supabase-js';
export function cloudClient(config){return createClient(config.supabaseUrl,config.publishableKey);}
