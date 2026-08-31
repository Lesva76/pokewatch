@echo off
cd /d "%~dp0.."
pip install -q -r requirements.txt
python local\run_local.py
pause
