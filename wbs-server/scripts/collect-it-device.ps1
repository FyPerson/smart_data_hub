param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$session=$null;$drive=$null;$passwordValue=$null
$result=[ordered]@{started_at=[DateTime]::UtcNow.ToString('o');completed_at=$null;source_host=$null;server=$null;volumes=@();controllers=@();component_errors=@();cleanup_warnings=@()}
try{
 foreach($line in (Get-Content -LiteralPath $ConfigPath -Encoding UTF8)){
  if($line -match '^\s*(IP地址|IP|HOST)\s*[:：=]\s*(.+)$'){$address=$matches[2].Trim()}
  if($line -match '^\s*(用户名|用户|USERNAME|USER)\s*[:：=]\s*(.+)$'){$account=$matches[2].Trim()}
  if($line -match '^\s*(密码|PASSWORD|PASS)\s*[:：=]\s*(.+)$'){$passwordValue=$matches[2].Trim()}
 }
 $ip=$null;if(![Net.IPAddress]::TryParse($address,[ref]$ip) -or $ip.AddressFamily -ne 'InterNetwork' -or !$account -or !$passwordValue){throw 'CONFIG_INVALID'}
 $result.source_host=$address
 $credential=[PSCredential]::new($account,(ConvertTo-SecureString $passwordValue -AsPlainText -Force))
 $session=New-CimSession -ComputerName $address -Credential $credential -SessionOption (New-CimSessionOption -Protocol Dcom) -OperationTimeoutSec 12
 $system=Get-CimInstance -CimSession $session -ClassName Win32_ComputerSystem -OperationTimeoutSec 12
 $bios=Get-CimInstance -CimSession $session -ClassName Win32_BIOS -OperationTimeoutSec 12
 $os=Get-CimInstance -CimSession $session -ClassName Win32_OperatingSystem -OperationTimeoutSec 12
 $cpu=@(Get-CimInstance -CimSession $session -ClassName Win32_Processor -OperationTimeoutSec 12 | ForEach-Object {@{name=$_.Name;cores=$_.NumberOfCores;threads=$_.NumberOfLogicalProcessors}})
 $result.server=@{name=$system.Name;manufacturer=$system.Manufacturer;model=$system.Model;serial_number=$bios.SerialNumber;os=$os.Caption;memory_bytes=$system.TotalPhysicalMemory;cpus=$cpu}
 try{$result.volumes=@(Get-CimInstance -CimSession $session -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -OperationTimeoutSec 12 | ForEach-Object {@{name=$_.DeviceID;filesystem=$_.FileSystem;size_bytes=$_.Size;free_bytes=$_.FreeSpace}})}catch{$result.component_errors+='Windows卷读取失败'}
 try{
  $driveName='ITCheck'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $drive=New-PSDrive -Name $driveName -PSProvider FileSystem -Root ('\\'+$address+'\C$') -Credential $credential -Scope Script
  function Read-StorageReport([string]$Kind,[string]$Controller,[string]$Format){
   if($Kind -notin @('controller','pdisk','vdisk','enclosure') -or $Format -notin @('xml','lst') -or ($Controller -and $Controller -notmatch '^\d+$')){throw 'REPORT_ARGUMENT_INVALID'}
   $file='it-inspection-'+[guid]::NewGuid().ToString('N')+'.txt'
   $remote='C:\Windows\Temp\'+$file;$shareFile=$driveName+':\Windows\Temp\'+$file
   $reportArgs='storage '+$Kind;if($Controller -ne ''){$reportArgs+=' controller='+$Controller};$reportArgs+=' -fmt '+$Format
   $command='cmd.exe /d /s /c ""C:\Program Files\Dell\SysMgt\oma\bin\omreport.exe" '+$reportArgs+' > "'+$remote+'" 2>&1"'
   $process=$null;$finished=$false
   try{
    $process=Invoke-CimMethod -CimSession $session -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$command;CurrentDirectory='C:\Program Files\Dell\SysMgt\oma\bin'}
    if($process.ReturnValue -ne 0){throw 'REPORT_START_FAILED'}
    $deadline=(Get-Date).AddSeconds(25)
    do{Start-Sleep -Milliseconds 400;$running=Get-CimInstance -CimSession $session -ClassName Win32_Process -Filter ('ProcessId='+$process.ProcessId) -OperationTimeoutSec 8}while($running -and (Get-Date) -lt $deadline)
    if($running){throw 'REPORT_TIMEOUT'};$finished=$true
    # Do not probe the nonexistent file before creation (SMB negative caching).
    $text=Get-Content -LiteralPath $shareFile -Raw -Encoding UTF8
    return [string]::new($text.ToCharArray())
   }finally{
    if($finished){try{Remove-Item -LiteralPath $shareFile -Force -ErrorAction Stop}catch{$result.cleanup_warnings+='本次临时报告未能清理：'+$remote}}
    elseif($process){$result.cleanup_warnings+='报告进程未确认结束，未清理：'+$remote}
   }
  }
  [xml]$controllers=Read-StorageReport 'controller' '' 'xml'
  foreach($c in @($controllers.OMA.Controllers.DCStorageObject)){
   $id=[string]$c.SelectSingleNode('ControllerNum').InnerText;if($id -notmatch '^\d+$'){continue}
   $entry=@{id=$id;pdisk='';vdisk='';enclosure=''}
   foreach($kind in @('pdisk','vdisk','enclosure')){try{$entry[$kind]=Read-StorageReport $kind $id 'lst'}catch{$result.component_errors+=('控制器'+$id+' '+$kind+'读取失败')}}
   $result.controllers+= $entry
  }
 }catch{$result.component_errors+='Dell硬件管理读取失败或不可用'}
}catch{$result.component_errors+='服务器连接或基础信息读取失败，请联系管理员检查采集配置'}
finally{
 if($drive){Remove-PSDrive -Name $drive.Name -ErrorAction SilentlyContinue}
 if($session){Remove-CimSession $session -ErrorAction SilentlyContinue}
 $passwordValue=$null;$credential=$null
 $result.completed_at=[DateTime]::UtcNow.ToString('o')
 $result | ConvertTo-Json -Depth 8 -Compress
}
