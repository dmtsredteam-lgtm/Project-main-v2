@echo off

setlocal


for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (

    set IP=%%a

    goto :found

)


:found

set IP=%IP: =%


echo Using IP: %IP%


if not exist gisec-hub mkdir gisec-hub

if not exist DMATICS-Red-Team-Challenge-main mkdir DMATICS-Red-Team-Challenge-main

if not exist dmatics-cyber-arcade-main mkdir dmatics-cyber-arcade-main


set ADMIN_TOKEN=gisec-demo-token

set ADMIN_PASSWORD=booth123

set SECRET_KEY=gisec-secret-key


(

echo PORT=7788

echo ADMIN_TOKEN=%ADMIN_TOKEN%

echo ADMIN_USER=booth

echo ADMIN_PASSWORD=%ADMIN_PASSWORD%

echo REDTEAM_URL=http://%IP%:8000

) > gisec-hub\.env


(

echo SECRET_KEY=%SECRET_KEY%

echo PORT=8000

echo STATION_ID=LAPTOP-01

echo STATIONS=LAPTOP-01,LAPTOP-02

echo HUB_URL=http://%IP%:7788

echo ADMIN_TOKEN=%ADMIN_TOKEN%

) > DMATICS-Red-Team-Challenge-main\.env


(

echo ADMIN_USER=booth

echo ADMIN_PASSWORD=%ADMIN_PASSWORD%

echo ADMIN_TOKEN=%ADMIN_TOKEN%

echo GISEC_HUB=http://%IP%:7788

echo REDTEAM_URL=http://%IP%:8000

echo NEXT_PUBLIC_GISEC_HUB=http://%IP%:7788

) > dmatics-cyber-arcade-main\.env.local


echo.

echo Done.

echo Hub URL: http://%IP%:7788

echo RedTeam URL: http://%IP%:8000

pause