SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'workspace_qlix' AND column_name = 'owner_password_enc'
);
