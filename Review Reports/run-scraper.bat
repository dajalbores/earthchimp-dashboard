@echo off
cd /d "d:\Claude\Wyldsson\Review Reports"
node amazon-scraper.js >> "d:\Claude\Wyldsson\Review Reports\scraper-log.txt" 2>&1
