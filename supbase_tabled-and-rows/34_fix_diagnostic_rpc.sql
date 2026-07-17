-- ============================================================
-- SQL Helper: Database Diagnostic RPC
-- ============================================================
-- Run this in your Supabase SQL Editor.
-- This function allows your diagnose_database.js script to read 
-- the schema (table columns) directly from the information_schema
-- without needing actual data rows.

CREATE OR REPLACE FUNCTION public.get_table_columns(table_name text)
RETURNS TABLE (column_name text, data_type text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY 
    SELECT c.column_name::text, c.data_type::text
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' 
      AND c.table_name = get_table_columns.table_name;
END;
$$;

-- Grant access to authenticated and anonymous users so the JS client can call it
GRANT EXECUTE ON FUNCTION public.get_table_columns(text) TO authenticated, anon;
