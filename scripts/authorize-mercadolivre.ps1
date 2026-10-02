$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Web

function ConvertTo-Base64Url([byte[]] $Bytes) {
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$clientId = '5379077874118224'
$redirectUri = 'https://boompromo.vercel.app/'
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$random.GetBytes($bytes)
$verifier = ConvertTo-Base64Url $bytes
$random.GetBytes($bytes)
$state = ConvertTo-Base64Url $bytes
$random.Dispose()
$sha = [Security.Cryptography.SHA256]::Create()
$challenge = ConvertTo-Base64Url ($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($verifier)))
$sha.Dispose()
$authorizationUrl = 'https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=' + $clientId + '&redirect_uri=' + [Uri]::EscapeDataString($redirectUri) + '&state=' + $state + '&code_challenge=' + $challenge + '&code_challenge_method=S256'

Write-Host 'O navegador vai abrir. Entre na sua conta principal e autorize precosBOOM.'
Write-Host 'Quando voltar ao site BOOM, copie a URL COMPLETA da barra de endereco.'
Write-Host 'Nao envie essa URL, a chave secreta ou os tokens pelo chat.'
Start-Process $authorizationUrl
$returnedUrl = Read-Host 'Cole aqui a URL de retorno'
try { $returned = [Uri] $returnedUrl } catch { throw 'URL invalida. Execute novamente.' }
if (-not $returned.IsAbsoluteUri -or $returned.Scheme -ne 'https' -or $returned.Host -ne 'boompromo.vercel.app' -or $returned.AbsolutePath -ne '/') {
    throw 'O endereco de retorno nao corresponde ao aplicativo.'
}
$query = [Web.HttpUtility]::ParseQueryString($returned.Query)
if ($query['state'] -cne $state) { throw 'State invalido. Execute novamente e use a nova autorizacao.' }
if (-not $query['code']) { throw 'A autorizacao nao retornou um code. Execute novamente.' }

$secureSecret = Read-Host 'Cole a chave secreta do aplicativo (ficara oculta)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
    $clientSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $token = Invoke-RestMethod -Method Post -Uri 'https://api.mercadolibre.com/oauth/token' -ContentType 'application/x-www-form-urlencoded' -TimeoutSec 30 -Body @{
        grant_type = 'authorization_code'
        client_id = $clientId
        client_secret = $clientSecret
        code = $query['code']
        redirect_uri = $redirectUri
        code_verifier = $verifier
    }
} catch {
    $status = 'sem resposta HTTP'
    if ($_.Exception.Response) { $status = [int] $_.Exception.Response.StatusCode }
    throw "Falha ao obter token (HTTP $status). Nao compartilhe detalhes que contenham credenciais."
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $clientSecret = $null
    $secureSecret.Dispose()
}
if (-not $token.access_token -or -not $token.refresh_token) { throw 'Resposta sem os tokens necessarios.' }

$items = @('MLB6781687878', 'MLB7514174346', 'MLB6545552150', 'MLB4590121239')
$checked = 0
foreach ($item in $items) {
    try {
        $price = Invoke-RestMethod -Uri "https://api.mercadolibre.com/items/$item/sale_price?context=channel_marketplace" -Headers @{ Authorization = "Bearer $($token.access_token)" } -TimeoutSec 30
        if ($price.currency_id -ne 'BRL' -or $null -eq $price.amount -or [decimal]$price.amount -le 0) {
            Write-Host "$item : resposta sem preco valido em BRL"
            continue
        }
        $culture = [Globalization.CultureInfo]::GetCultureInfo('pt-BR')
        $formatted = ([decimal]$price.amount).ToString('C2', $culture)
        Write-Host "$item : HTTP 200 - $formatted"
        $checked++
    } catch {
        $status = 'sem resposta HTTP'
        if ($_.Exception.Response) { $status = [int] $_.Exception.Response.StatusCode }
        Write-Host "$item : FALHA - HTTP $status"
    }
}
Write-Host "Produtos com preco confirmado: $checked de 4. Nenhum preco ou link do site foi alterado."
Set-Clipboard -Value $token.refresh_token
$token = $null
Write-Host 'O refresh token foi copiado para a area de transferencia, sem aparecer na tela.'
Write-Host 'No GitHub: Settings > Secrets and variables > Actions > New repository secret.'
Write-Host 'Nome: ML_REFRESH_TOKEN. Cole o valor e salve. Depois limpe a area de transferencia.'
Write-Host 'Envie pelo chat somente as quatro linhas de resultado HTTP e a quantidade confirmada.'
