CREATE POLICY "admins insert economy_ledger" ON public.economy_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
