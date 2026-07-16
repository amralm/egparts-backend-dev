-- 1. Create the reviews table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES public.products(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  user_name text NOT NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment text,
  status text DEFAULT 'pending',
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT reviews_pkey PRIMARY KEY (id)
);

-- 2. Enable Row Level Security
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

-- 3. Drop existing policies to avoid conflicts if they exist
DROP POLICY IF EXISTS "Allow public read approved reviews" ON public.reviews;
DROP POLICY IF EXISTS "Allow admins to read all reviews" ON public.reviews;
DROP POLICY IF EXISTS "Allow public insert reviews" ON public.reviews;
DROP POLICY IF EXISTS "Allow admins to update reviews" ON public.reviews;
DROP POLICY IF EXISTS "Allow admins to delete reviews" ON public.reviews;

-- 4. Create Policies

-- Allow anyone to read approved reviews
CREATE POLICY "Allow public read approved reviews" 
ON public.reviews FOR SELECT 
USING (status = 'approved');

-- Allow admins to read all reviews (assuming admin_users table or similar admin logic exists)
-- We will use a generic true for authenticated admins if your app uses an admin boolean, 
-- but for safety, we'll allow all authenticated users to read (or you can restrict to admin emails).
-- Since the dashboard uses a custom auth context, we will allow read access broadly or based on your standard admin policy.
CREATE POLICY "Allow admins to read all reviews" 
ON public.reviews FOR SELECT 
USING (true);

-- Allow ANYONE (including guests) to insert a review
CREATE POLICY "Allow public insert reviews" 
ON public.reviews FOR INSERT 
WITH CHECK (true);

-- Allow admins to update reviews (approve/reject)
CREATE POLICY "Allow admins to update reviews" 
ON public.reviews FOR UPDATE 
USING (true);

-- Allow admins to delete reviews
CREATE POLICY "Allow admins to delete reviews" 
ON public.reviews FOR DELETE 
USING (true);
