@echo off
cd /d "%~dp0"
echo [1/3] Adding changed files...
git add -A
echo [2/3] Committing...
git commit -m "Update website" >nul 2>&1
echo [3/3] Pushing to GitHub...
git push origin main
echo.
echo Done! The website will update in about 1 minute.
pause
