-- Migration: Add missing amount column to feature_reservations to prevent upload limit check failures
ALTER TABLE public.feature_reservations ADD COLUMN IF NOT EXISTS amount integer NOT NULL DEFAULT 1;
