# Git & Code Review Rules

- **No Git Commits**: Never run `git commit` to package changes. Always leave files modified in the working directory (unstaged or staged).
- **No Git Pushes**: Never run `git push` to push local branch commits to any remote repository.
- **Goal**: Keep all modifications fully visible in the local git working directory so the user can easily review the side-by-side diffs in the VS Code Source Control view before staging and committing/pushing them manually.
