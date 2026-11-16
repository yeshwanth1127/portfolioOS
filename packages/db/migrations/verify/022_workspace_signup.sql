SELECT to_regprocedure('auth.signup(text,text,text,text,text)') IS NOT NULL
  AND to_regprocedure('auth.create_workspace(uuid,text,text,text)') IS NOT NULL
  AND to_regprocedure('auth.free_workspace_slug(text)') IS NOT NULL
