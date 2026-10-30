function Disable-TenantMcp([string]$ConfigPath) {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return }
  $encoding = [Text.Encoding]::Unicode
  $text = [IO.File]::ReadAllText($ConfigPath, $encoding)
  # Windows INI files include CR before LF. Match it without consuming it.
  $text = [regex]::Replace($text, '(?m)^Enable=1(?=\r?$)', 'Enable=0')
  [IO.File]::WriteAllText($ConfigPath, $text, $encoding)
}
