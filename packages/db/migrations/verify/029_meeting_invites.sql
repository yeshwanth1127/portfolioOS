SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'notifications' AND column_name = 'link'
);
