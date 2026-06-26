/* NghienDe Admin SPA — vanilla JS. Đăng nhập JWT, 4 trang: Tổng quan / Hệ thống / User / Thanh toán.
 * Song ngữ vi/de, sáng/tối. Mọi secret nằm ở Worker; trang này chỉ giữ token phiên (sessionStorage). */
(function () {
  'use strict';
  const WORKER = (window.ADMIN_CONFIG && window.ADMIN_CONFIG.WORKER_URL) || '';
  const LOGO_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAADoUSURBVHhe7V0HmFXF2T53d+lVENhdyi5GMLFhhOS3KxjEHmsUVNDYECQqIFJUBFERFUGBGMFCBKyJii2AGqQI0jssVURgd4GlLcsCe+/7P9/Ub+acuyzFksR5nu+558yZmTNn3ne++abeIAiCtUEQFHCJefe/yH+elBFDwj4oDIIAv8h/jsQi/A5TCHvBBP/BL/K/IYT9/w4BompOWf3+S+V/iwA/lfiE8u9/QvmFAD+U/IxALk3+uwlwKCAcStiyyKGmd6jhj5L8dxPgFzmo/HcQ4CeqPYctP6P8JifAoWTyUMIeqfyY7/ofkOQEIPmlsMsmP2Y5HeV3lU4ALkf5xb/Iz0PKToBf5L9SfiHA/7j8dAT4MZqUY489Fi1atMB1112Hrl274oWhL+D1119Hnz698fmkSZg5c6aQ6dOn48svv8T48eMxevRoPPvss/jLX/6CP/7xjzjllFNQo0aNUNr/JfLTEeCHkCbHN8Ett9yCl156SQC7detW+G7wc4MxZMjzAuQyuUQCmzdvxuTJX2HQoEG4/IrLUbdu3dC7D1UOpQIcStgoKSX+fw4Bkn0E1fB+/foJwPft2+fDJ1w8Hhe/H3zwPvr37y+ue/fujYkTJpjnJSUlKImXiOu4+k2oeL4rKCjAp59+ik6dOyE7OzuUp59KkpVRKfKfQwAu9etnolu3bpg9e7aPjQSwhEBkvwrIPn36YOrUqeKawB8wYICMQ+EMAeyvjiuuS6RfIuGSorCwEB98+AGuvuZqlCtXLpTXn7n8ZxHgt7/9LUaOHIkdO7Y7IEjQOFBxeU/XClxyEydOxD333IP3338f7drdhK+//lr4U+03YIs4LD1HXDLodLVbtmwZHnjgAdSsWTOU95+plI0Ah6FaDllKe8dpp52GcePGmZpMzoClwPYJEOV2796NNm3aYOSoUbj7rrvw2muvCX8DKNMAQogI6plMn5GEhy8hzZAw7/luw3fo1r0bqlSpEvqWw5XSyucIpGwE+KkkIyMDL774Ig4cOGAKl2q0AMWptVbNc7dx40ZMnz4Nb745TqTTrl07nHP22Xj55Zdx1113YeiQoTJNQSALpiGSLyxcWDO4zQ25lStXinf63/Uzkp8vATp27BhpxZfmdu3ahc8++wz33XefMA6rVasWSpeEnlNvQboEA5GBakBnv74YfxaXEVM7MhhPPPHEUD6OVEgrHKFm+PkR4Ne//jVmzJhhCm/btm2iG7Zp0yZs2bIF27dvx86dO7F121Z8++23IizV6JtuugkNGjQIpRclH3/8MXr16oWtW7eId5QIDWLB1E1AGGh2r8TYGuqZqyHipmkgY/H+++8P5eUnlkMnwBEyrlQhtbw5NxejRo3CJZdcgl/96leoU6cOqlevLqR27dqoV6+eaBpokKdSpUqhNMoi77zzDnr17CUIRc42JVEAuyTQtoFDDBY+FE81UdoR+TIyM0J5OpgcrXLX6ajfQyeAL0cjY7FYDGPGjMGaNWtwxhlnhJ4fbXnllVfQu1cv7NixgxHArcXGANSA+lpAxeFhHEKEwlpt8N133+GCCy4I5esnkCMnwJEK1fA5c+aILlqyNvtoyxtvvIGePXti3bp1igARKj9Uu8MkMb9RJPDTY1qGHBm2d9xxRyhvP7L8tAQ4oekJ+H7D93jhhaGhZz+kjBgxQowEWg3gg8aaBEaAUG3nYPuE8Qng+NkmoW/fvqH8HYkcokYuOwGSJZzM/2BCgzpbt25D9+7dQ8+OpkTlj+YKHn30UXz//fduE+CBpK8d4EPEsOITxNcOdkxBinZDhgwJ5fGHFFYmZSfA0ZTTTz9dDMrcfvvtoWdHW5IRgOYPVubkOBpAtv3hHoEmhmMQOqRwQXZsCJ8EJm15r+2C4cOGhfL5I8iPTwDqD1M37tZbbw09+7Hk+eefxyOPPCKMTp8ABlBxz7t4/ghgEk2gRyYjjEjHbtDXjASDBw8O5fUHlh+XAPXr10debi7u7dw59OzHlGeeeQZPP/20GW+woNqaaax8Drjz6wNv/XzwDdgmjCWTJp0mAU1Y+fklidJkhytH3AQcTmbKly+P5cuX48knnww9+6GkYiyGJmnl0KZCJXSsUg1PVKuJ+4JUPDNwIAY+MwgL5s/3CMAmkJhdkFSV+zU8IlwYfDcOJ452P+LwcdkJcDigc/noo4/x9rvvhvyPlqQGAbJT03BZxcroU60G3qlVFwvq1Ed+ehb2ZmbjQEY2kJmNL2Ll8dyzz2LIiy/io48+UgRgtVuAwgigryPAlQBGdQ+ZUclJwIkRRQLVOyguLkbz5s1D3/gDSNkJcDApjSD3d++Ob5YtRZCWKsJVjsVQMyUFdVNSkZGaioyUVKSnpKJuaipqpaSgWkqKqL1pQYAUlTb9VojFcExKCrLT0vD78hVwfaUq6FOtJsYcUwcz62RiU71GKM7MRklmNvZmZGFnRha2ZmQhL70hcus1xPbMLMypWBWPdemCgYMH46uvvrIE0GCGwPHIYACzxHAMOw20iuO0+356PkGU7UBu1apVYvTTL0u/zEsr9zJINAGOMFFHTmreHCW7duGLU0/H+5VrYmbdTCysVx/L69XHmnoNsC69IdaJ3wZYk94QK+s1wNJ69TG/TiZmHZuBr+tkYHqdDMyok4H59eojJ70BNqU3xK6MLBzIbIx4ZmPsy8wW99vSs5Cf0Qh56VLsdUPkZTTCzvrZmJxSHv17PIRBzz8v1gK6TQADif06qt2vzTye7+fXem5YRoS1/lITvPXWW6HyPMpiCXA0QdeSkpaGWStWINGtJ3aWqypU8W5VM7dnZKEgPQvbMhqhQAn5kexQYQhUCi8kMwu7MrPF820ZWdiSIQEWIDPQNfAa/Hx2T2lMSK2Axx9+BKNefx3//Oc/HQI4NZeDxPyTEoEDyu51mtpG8MMLPxZHP0/EpVF4y823hMr1KEq0Bjha0mvQIGDqdORXqoH89IZSMhoqYOSvqJ3mmoHGgdRgGz9Z061kIU+IDkvPtdhwBRlZWFi+Cvrf0wmPPzMIX3zxhSWAA6BV+Y7xxmtrGQkQApuBHALf0RBSC9BsKC2B88v2KMkPR4DjTz4Ze7duw85TmyPvmLpubVVg+sDbe/UrwobBzs+04MrnWcjLtCSwwLsk2JmZha/SKuLxnj0x4uWX8bExAiOsdNZOOyuOIgghgQuD74DNgY4gh/PM2BeSBG+++WaofMsqvmb37o8OAfyXkHz41WRgwEBsTqusAOMgKjJokM1vFAG8eJQWgW1IoEQQICI8I4MwAitURZ+7O+KFl17Cu++869kA2kBjwoAOga/AkgQJgxklHHyHCA6pJPj0XI8PtGzZMlTGR0FKJ0AUsGWRC6+6Cli1GltqpSOfumIcCNEUuCreIQPXEiFRtT+KAE4TwMG3BNiWmYVF5aui7x13iibAdAO1yvcBYYAbsDgJfL9k/uzer/28OXDjSRJoLTB3zhwxbe6X9RFK6QQ4XJm5eBHid3VCbqXq4ZoYAb4Az6nxXGNYAK3q9yVZHJcQOzKzMD21Evp27YoRo0bhH//4h9IAtqbrdliqYg/EUknhGY8++B7ovHlw0+KLXFW+lBa44YYbQmV9hBJNgMOt+SSX3ngjsHgptlSrjfx6ZPS5QFhAXJCE8Rfh74LKn7kk4GHFdb1GyDs2C3k1s5BbNRu5lbKxtUo2VqTVxCMdOmDAc8/iX//6lyhYp68eBbYPvN/uexKuzR4J+L0KHxXHzkVILUDLztPS0kJlfgQSTYAjkalz5+LA7R2RW7mGBZcD7d9rA7BUkF1ihAiQnoW8OtnIq5GN3MpS8mo3wpYmDVBwTj3svOFYFD5QE8VPV8W6fqno2+3PeHX0OIx+/XWrAXRhqwJ3AHJqdkQ/3r+OAFxrlKS2AvN3mgVBBtqlJLXAjTfeGCrzI5CjS4Cz27QBclYiv2Zd5NVr4AJMNZKEwBIDNkrtGwJYFS9JIq16e6+0RN0s5NXOkmBXaYy8KtnYUjsL25o0xPaWGdj151ooerIa9r1ZESX/TkNiXgxYHgNWxoC1AdZOCvBw77swZOhLtgkwBe2KA7pfk33A+HNTg1XtNmmGRwBNXJZWSCMwW4B2Q/nlfgRydAkwbvzHiHfvh01BDaFyN1cm9ZuF3OpZyD0mC7kEXO0s5NbKRl7NbORVz0Je1WzkCSAbK0CPQ27lxlbIr2pj5FXLRt4xWciv3xBbT6yPgpbp2Nm+Nooeq479f6+E+L/LIbGIgA6EJJamILEgBYm5qYjPTkVidiowLwWF0wL0euAyPPPcCLE4VDQBHFQNFAef/3LATDMgn0kw7RiCaM+dtBkBzLv8d7K0uLA1heeef36o7A9TCoLfB0HBGUGA3yn5PUlM/R5EdHj6bZ3VGIXrv8Xui5pix5U1sbtLLezpVx17h1RB8cuVsG90Jex7oxL2/b0i9r1eEcUjK6F4RGXsfb4Kip6qJsLu6VMDhT1qorBrTaGyC7vVxJ6eNVE0oAaKh1bF/tGVcODj8ohPS0ViYQxYEQArYg7YiTkkKeI3PicNcfEr/bEgFVs/D9DzgWvw0stviP61IUBItXsk8GqvBTu8ISWZc7qLvDnQJAiBHiYIufFjx4oyl7jF8H9BIMTHpzSh8L8jAqyNxQo2xAKsicWwJgiwNkYSE7KOXZOsoXAB/UpZrYTi7ezxJLB3NBIzA6VyA2BVAOSo+2UxYCmBFQDLlBCA9FyLqr0hoWcUdllM1PLEfAI4RdRqCbgF2QAuyJBmntO9IAA1Ad2vw99GjjEEcGtgEgJ4+wD5VrCCgu2iORn41FNiw0nbtm1x1VVXCav9iSeeEJNORUV7TDxLqmjgQ00A1zSUyI4d2FivLlYFgSh/i5cUgRPDTmIrfzW+38tnBcGyICigRJYdjqTEsCwIsDAIUDRrMZB7MRKzAgFOfHaKAcWKrJlCZivVLK5lePoVoOp7AlOpb/FMxGdpCCGQJdDmfaT2lQYQz+ZKTYD5qdj7dYCef2mJka++LbaLkYsnorabueDTVvH1367Hq6++asYPli5dKlY2/eEPfxBz+Pfeey+GvTgM77z9Nt595x387W9/Q6dOnXDRRReJ5e60GFU7bjc4NoR+tyIG72lIe0JqnO//fDsWBAGWxwIsVXgsV7IsRv4MpyAIXRPmy4kAS4JYwapYDEuDGJbEpCxViUpR14G+d2UJsfDEFigpWobEgopIzA4UWAo4DowBXwOuSUFkYXF0fCeOe2/TtCCbX0MAIoP2SxMEIBug5/0XY9iI18QGlENxtLWcVhI91LOn2Il01llynyFpEqrptNQtmaPFMLQXoEP7DsbPqflJNIF5xoxKcrs++RiLgkCUv8GGXytsBJ7aX0ssBsJ8WUAEiMUKVnJQTWIqIieDQxL6DbA4CJDX/Qmg5HXEZwSq5roECImu7Z5/iChchYeEanXEc00Ephmkv9QAJbMC9OpyFka++g7+/ve/Izc3F++++644K4DW6V999dXiSBmqzbR9jGotTcvS8TGjRo1Ely5dxA7j5557TixsJUebUPs++ijGvPGGBdbYDe5BEx1u7YA77rhdhuO1nfc6PBL4hiQ1PiU7d2JFnTqi/P1KaQmg8eIYymuXAElqtw7sJGr8iVWSgbsnTgfyrlcEkGpbCGuTHXCT1XJPoghh1Lpn4IXjaY2g/AUBUoTt0fXO03Dvfb3F1jMCk9Q4EeCVUaMEKV559RWxbpCWrFObfu211+KKK67ArbfdhtdHv449hbI91yByF9m2C6BtuPPPP9+cVGJVvwXaGZDiIrSANTw3XHut0AI+RhonIUQCji/XALoJCBHAqAqmAUwY7hcg59j6OJCfg8TSOrL9ZwSIBsb382pqaaLacksABrAXToTl4M9LBdal4bNhAbLrV0Dbtjfhgw8+EJs2D8fJ9phb8l63z9RYurY2BTnSOieffDLWrZU7k6JquSGEQwRtn6ip4hEjFAE8Lc2bAac5t2FWBZwAHmNk7Za/2njQ4Gu1IhIPAnx/8fVAfAriAvyDtP3smW0eygg+pSfUu7oncE177xmc4lmKUPlYmAYsiQHrUvB0lwDNW5yPadPnOGAK4HitM+qbXzOAeY01cVRYH/xQOAkenVb2+9//XlxTzyCclrzm+eIDSuSK5s/DYoUDB1irfcee87QAYa4IEBTkKGOB2hMR0dEA1prkL6BfYl/+I4OB/S8iPlNa/66lbtW8BIg/P3gTwONqgA3QAuRUQACdAixOAVakAKtTZNdxSYDiGQE2fRbg20kBnukS4PyWV2JPkayFFiy3HXZB5/fyl84I0nE5gaKA56DZIWA7oHP55Zfh4YcftmnoMCasSkP5WfLJ7mDJnj1Y0aCBxU2BaytzuPZr7EwTsFQZgRRYsMmoDSnLuEZQCWpmEQF2vD8J2NZe9P85uAKURSnAEmp3U4Dl9JsKLEmV/gtTRL+cRucEiHN9crgkMUBTPEpvVaoEe3GAnV8FmPdGgDcHBHjszgB3Xxvgxstq4Ko2jXHDNefgtFOboEHD47Fzl2y7eS0OAeeo4/AgDycDnU+g9xe6zxh4/ntYunl5eWjUqBGWL1uu4jOAGRkcraPJpEj0bZs2pjdggOeagDcHTHuLnp/TBKi2Q4pklIwYVi8ysQCLU8ph75J5wJpTgNlU62LAqhRgaYDdUwIsfzfA9JEBPhsSYPyzASa8GGD6qACL3wqw/pMABf8OsI8GjuYFAsjIwSG6p8GjeQF2TA6Q816AScMDjHgoQPebA7S9tAquuuRE3HjD1eja/RG8OGIsPps4CwuXfIf8rXuwvwRodeHF+PRTOfMXVbOddpvVMtrBSyeOUE/gwQcfROvWrc3wMbmnnnpKHGhBJ5atX7/e+DvteUS6elCH3GOPPYarrrra5E3bFqF4EffkNnfrJsZhTJePY8XsAw6+IQDvBhrwTWDWdnC1olQNqZ2czMbYtXEJsLIGMCfAlJEB+t0ZoN1lFXFlm6a49uqL0L79zbj9zo7o2Ok+3HFnR9x66y248YYrcNUVZ+PKi0/CNZdk47pL6qLtZdVw8+VpuOOaGO66VtZi+r3tqhTcdEUVXH9pOq68+De47urWuOPOu9G3//MY+/YEzF/0LXbutmcI+Y5OFWtLU9QR3S55zc8ItIVMaprOHSTgO3fuLA6W/Gj8eHFsjU6H3Nx588TBFk2OP150EekEE0ksVotDbbl8TodQ0po/2i6nj7wz4f18RviT2/bKKGMIOgRQNV826Z49EEkAwxqlNpgNoGu+lsWBJMCWln/AzFmT8UDbAFdfVBs333wThg4fg5mzc1CwI/rQRu1odnN3YQk25xVi9bp8LFyyHl9/sxz/nrIQ//p8Nj6ZMFP8Tpm+BHMXrMXqtfnYsSs50BpIDg7dn3nmmZg3d54Mw2sQIwBdU19dDNOK+Joo4SaAnH6PnqIlRwdCERFWrFghgJU1ndkGXDQRVD7Hjh2Ls886W1zboWI/n96YgIq7+99fShuAtfeWCMpoN89cApTSC1CRTQIuAUiIddtuvgXT581D3/5DsXJ1rikM7ahQTU0w13pgxBbeoThZQLJgaSevWaxpwLSbK+j0UBqmlfF4Xii8DRflTGGbNL1abb7JgqFdCHAffFOrJemoqaGj8OgwKRHfmzRy4rJ3UwkW5+RgWVqaZ/C5al8QwlRq1Q30CeDUfp6Aag5cEgRiHPr7Tve6H84Zz4Yu6d4YL0b8hZSWIBxImx4HzwOA+WmgyNE+xB49eohrqeYtYBr8oqIiPPfcYLHQokOHDuh8b2esXr06eU10/Nj71bc73+TnV72XE0v3COgASxqJ1OUo81t6ehRz/5YtWF772CQWv+0dmIot+/92JFD0ArilyJnj2AUyscVKyPDIf+JJlWH/49x7/jEuCVyRH8v65Ca8IoVfELowuL8qXHKdO3fCqJFyvN/kQYWlgt+zZ484o4AOm6JlcBXKlxfz5H/6058MEPx95tu8d2uQzPebcGGNoZ0moHZ0TE7TJk1Ez0A0IfycAv0e9W3meymPxXuRc9xxzpAwr6g+hrpyhzSAiRSh7rkfvUgTYNtf/yoybzPnZjBUYBxQv6DYPSeRXwhOesn8VEH/+c9/Nrt/nPwpA2rhwoXCADv++OOdhRJ6kkjXRPOeZMLyoolmwbffRo7OMpw1a5a4piZq+LDh4pocHZzhLlNT5eF/n/pG3ZCubNbMGRIOYWcMQlvR7VwAIwAZd6Km6z5lqP3X/pIA20f/XWaWF4QBwb/2VbwtMF6Ybg1S8Xw//56F42PlNB9PEz22QHWhymtqe+l4Fpqlo4Mlacx//PgPXQC8/Jn3+vn1njsGIKv57du3F0fFUbfxllvao0/vPmIm8ZVXXhWTT9QU+QRwy9Hmn8YCiABrzj5bjQVYrNyemwVf/4pmX/YCAksA1WWQLFHdPa32leWvuxV0vesfem+dq6782iaBsYURyWheuGX1TwaSquF33303Hn/8cZcALBxf1MGdHpp12l9Ts9m9/96QyPeRSifXocOtGDZsmJhFPP305qLdp2llyiP1VmiMgdYNyDy4ZSqE2VXi3SrdtS1bGgI47b+u0BFEUM2+HAo2TYCKIBIQgCsRJKBfV0vsHj9eZECAyjLogO8XogrnFJTPdia6kIVxxwrC+WVpcA1ARuDll19uQDWF6L1TAqS7gG6Bu3l1nzvaivuJe20/yLx06fIXcfoHHUxFGoeWd9Ohl7fcfLP4A4qmTZri448+RrNTTzXTzO73hQnpE8CA72gDTQB3rYDVAEGsIIcFloBbsOl3kRj2VeCrFwgN8KFSl/oINQOcLVxea6wWcMMJVqt7e81+I2qjC4xKS/3qVTM0KJNer57tXvGCZGk71zotXtOSCf+O0L1Mgxy19Re2ulA0RxnpGaLPT2cinnvuebjkkksF6K1atsJXkyfj7LPPNgtL3DT9d8smQBDgAkUA1tZrnGzNd7uGDgF0N1ACL8G1tV6CLwjAEyYCvPueIYDOIN/R4pIiXHC+SpUFbwvTea7T92qe7to5tVGBQI4Wc9AfOcyfp46DYfE50ULx9b0jB9x7Hd/XBio+aZ29e/eKNQcfjh+P3/z612jSpImo+WRs0rrBWrVri2NxL27TRowGnnDCCdilCWC+JUKozLUNcN55shfgE8ADPzkBlLFn23mm9tUkkb4XTYTSADteUxarKUwOfLh22wKSQJuCNx+WRAWrAtVpmwJX7zDv1HHYc3IDBz6FY2rWxJIlS8Q9ObNCl6ev88ry4N+XRWRe5LtpKLpd23bC8CuXliZORqXzkipXroQa1avj0ksvQ5XKVcTawblz5wobgIxTOSrpfmOoPFQvYFWLFiENoAE3wDPxmoBArglk7JD9fb/9l6DLtkReF7zwgiKAtsB5RpPXTF6opjbyQvQLnX20AN8jCn+HvZbNkl6ORUu4SO3SPDx3LgE8O4MT2ssP9wtdq7jkaEyBSHDOOefg5FNOQc2aNXBR64tQsWJFseP3wQd7oGnTpnisb1+x3pAWl/J86UoSqiz0bUSAAwewsmlTzwbQQKt+v+nNuUPBggBLlRHodxu0JjDagHcx1PMtfexctq7pvFb5tdIpbP+Zf3/QOJ5G8QpfPpOaRlv7EydNxG9P+62oZdQeF+0pYlSQjhPIfAN7vwAjQvgzCk+OjDka4qWVR3Qy6vDhw1Gjeg0cd1xjpKfXwwUXtMRll10mTkFftXKlWItIB1mTC323cy3zRl91YPt25KSnO8a7NfzUtekNuANBigDhkUANvr1XiSkmUSIUZlMHucKVF5rTnhpAIhjMhRWg4+cXgp+udy0AYDWGg6g1AXW1qFY2btxYDLy0a9dWjAXQ2n1/Va/9Lrcp4ICH82WNP1osSt076uaRBqD1hW0uaoMLW7US/0fYODtbaCUart5XXCz+74AfYO1/u1/BiAD7vl2H5ZUqyfWZBnDVXReY6e4h89NNQNRIoASbE0AahLz2a5Ksb9lKZta0V7ageG3wP8T4lUoMrwnxJEQy/7n/XkWAkSNfFiqZQKHdttQvp/64Hgy6pX17UWN1310TIZResrywuQiy/ild2n9w7jnninWAzZo1Q3m1w5fu6c8pp02dJtYFXHjhhSKemETj6TLgNbHpGbmimTPM4ly/vZf3uubryiuFEUA1AZ6qMDXeDAjJMOYFtB/guF8hvm+fHJNmwPMM6w9wCs0HNgS+F9cBMqLQ/eeRpLK9AmprH1ercrmj2kcbPwg0Wq/39ttvm2e60J3vUGJIL4CzBKDRPlL9tIGEH+5Ai0jOO+98tGzZSoz+kfWfmZlpj67laTvfpQxC8T75jh1vv60MQEUAYwhaQvDJPR0uRADNGq0yjCZwBhUYw4IAKypWxL5164QqEoWeBFj3I6KvrXpj7TeLl6zwefxQOGNw2rGBp558UrT//lo8XuPJEVHOO+88obrNYg024EXp2+9ybQ1ydE1n/dWrWxcLFiwQWoVIRf90UqtWLdHuDx0yRMxGUtfw5b+9rN7ByoW9y/gbkd+T17+/uzScGfKcEPY5swFC08FKC5iBIN5uGMtSJa5HAydMlBn3C6YMH5JUxXE/3pzowtbXSsRz/i7//QogcqSO6VDmAc4QMY/vAkl/M0uADR8+zAlv48h0tSOy3PeX+4SFT6OQ1NaffdZZYuaRHP3r6IcffijWE1ITQecn9+rV26Stv5VLuCzt93x73fViXoaD7FRYUetdTaAJYBaFmm4gEz0GwA0HKzIhYt6WgU/LzPtqWWfcA8Spqey587EaUBZWP9NaxonvgO0KJw65v/51BEaNHCn+qIGAlotW3ILWZNCO+ufp6eli5Y7zrSpN+gsY6sfTmsHf/e534r8IyL7Yv3+/MCzJ2CRjjwZ+Bg4cKCZ/aHPIr447zmlmKE1OPvGd/NvUO4VQPqgLeMIJchAoAkNfc3Nx1gM4BHAsfjvBIEF3X0QE2MAWNJrawUDlvz44vDa5YHkfzYXHjSICJ5PxszWGAHj55ZHC6CKnDS6etiWfjUf7/1q1kkYvd4sWLRKjd7RAlGo0vdc4BSb50XA0rT245pprcOedd4r0CrZtE8/1t9AvEYCmiGmqWj7zvk+ElauB9q5ahaXlyjsGoMaGd9s1niECCA1Am0N5N1C1/VJtsE2F7Lm+JuatbtAA8aIiZQgy9ajZywHyQfQWf7gfGnHtg6T8DNiRpNMASyCHDXtR7Np1bAA/X0zI0d/W0faxa6+5Bt9t2ID1334runi0aJT+Zt7/J3LzfkagZI5/H7lJkz4X3dLnBw/GnsJCNSLolqv+loJx41wDkIQZ7rw3p59xAggbQBDARNQBVaJ6eFG197KHwBOkfQMBiqbL/+CVH27ZbOYFtOr2C9gDzwHar8WeRIHuiB9HFfCIEcNFAT/8iLchwxe2gING7/zTNWgghyaa6Jr+iJKcGb41qtut2WVxb735JkYMH+7+qxn/HpUeuY133eUagEZzu7Vf+GsCKBI4A0F2KJhZjkYY+Ixd+oViRPDRvjKjnKmmMJMUsFfYIk4yMJOA6mgZ/TwyrK2JtMafhoXddQI6jE1PA0Zr/s884wzxR9N0tOzYsWMwevRokUbXrl3FSB71FsiZ5sTYFG7tJ3sgJ2cFpkyZIuYG3nvvPXGwxCeffCLSpsEo0jTXX389rrzySmzJ36JWGKs0dT7VEPDqJk2d9l8DbY141Ywr456HizQCNYMsU9wegO0RWHuAMrCueXPZFTTLoSNAYHPpYcPGu/fE1wT8PvQufW3iay0kwXhm0CD87aWX0L9/P3Ev8iviyDAcONoxfOqpp6JQzc9HOdIQNIVL6/vJ+b0CMhBpp3Hr1n9AZkZGmY55+78zzsATAwbgwP79bFJIf5tMf88336gmujQCeBqbdQ1dG8BLwPxyg9AMFPGwagQqJQV7Fy2SBcBB98HRAHKAIkGzorVCSDP47/DjiWdW+2hH/Xuq/bRZRP9rWJR74YUXkJWVhfz8fHEv8s3yxElF1j9f0k2EoUWe9N+ENWqEm4+DyRWXXy5GKA2pvLIkl9uzV6j7p3GTJLBb/Wzbb2cMXQ2gPDlbbFuiVYgdKZTP7ctFd9Axqpg6jSSBVZX8uSxYF3wTzgeZp8MAceIrP6pFNMVKo3x0AAR11Wi3D6lv+vMoUu/09zFLlyzB2rVrRT+d/vp92dJl8pv8poa9nxxtCOmnehXkaHOID+qhSLMWLTDo6YHKBuAaQFr/8f37saZpE9lN5xWS4cg1twFfEcAsC/ebAKemOxFZogZ81iWk3kDjxkgUF8tdqwYQH3hXTBuexED0C9xoAh6Gh1XXLvEkSNT3vvnmm8XIHg3NkttbvBc9ez4k1uVR20uHOxEpCAR9krh9p+12cvuGHB0dc1qzZthbJGcXadCHBnh8YEnon1AapqaiWblyOK9cBVxYriJalauAC8pXwHnlK+DC1DRc0rw5nhg0yJ0YUt9Ibvfnn4tKRwY4x0bgwQw9PQ8g8FIGPZ0f5BIgogngmsDxNwNDtpshXypfsosmUVQ7GFnLndoTBTIbb/csfT9+qEZ66WhNRFWG0qFBGOqz39tFbmb5/PPPsXlzeDcTHQ1zb2cZRpOYq356L3+3NhbpICh+5tD5F8iz/CrFYmhVviIeqVoD79esgwW107GhbiYK0htgd72G2ENStyEK06UkatbF0DPPQvcnBpgFLKYc1Ls23HBD5OCPj1lYCHx1SJQ+IMIngGz3mbHnWI9qcYHRAlbtiNlBtQ2Lzw5qwEKg82c8TLJrJQ4pVJiQTSHENf5IA5DaJ4Pt0ksvFZrArL1TYXJycsS4/PaCAunP82fStmlKq19ev/fuu2j9h9bimhztSegUS8WSOpkozmiEeEaW+N1ZryG21WuA/Lr1heTRbz0l6Q1QfGwGRvzmJNz7yCOYN8/d00iO5l6WVagou+AMN58A/EwHDbr8taeEKQLYFUE6IUdtMMvRPpdk0NpAPpeJ7501S7ZTosCsPWABiQBXfaAE1w3j2AEqHaOGeTxOBvYeekaOdtw0P705li1bKqaDaXhWHA+jei4aNFpJbArdvJOTQIalQ6PI2NMaID8/D2eddZboFZCjwaHPgzSU1FP/jlK3IfJqNURu1YbIrdgQmys0RG6FBsit1AC5lRtgM/1WaoDiSpn4a+Zx6DqgP6bwP7VS783r/qDAxj+0w1RQBj6d7eD8ivMefAJ4Q8Ec5PALfKZpNSQTpYxtvOYamWndJfSB9tRqZCErf1/NC/XLwHbiOt05TgxpBBLY1NYPGjRI/HNodnY2Nm60vQB6Tn/VtmHDBlbolA5vyiQIFIYWd+i1e5oEtBF12rRp4vqdzz7FS2mVUFy9EfIrNsLW2o1QcFImtreui523HIPCrtWxp18VFD1dCUXPVELRwMooeqIK4oMr4uXbG6BH36fZv5qp1T95+VhRo6aobPocwEjgBeiKJB5Z9LU5J9DXAK7Kt5FKI4BOlA4tpN+i2fIMnjBIHnisYEPP9HWU6Djq2rTLXlq8uSDXif4r6PHHxYYRqq1k9N16awexLo/uqTtHTg+/WpIymwIQ/z08dOhQ9Y3y2BhyZAdMVwSYtmQpHqtZC/Gz6qLooeo48E4FxGfQiSkRJ6AqSdDvxgD/GFYdXR8cgIkT1UyrIl5+jx7K+HPB5pUwSrjBzpsARQCrATjQzr0xOHhCWtwXiwmiiy+WGVe2QMjC98H2f1kcR1MwIyxSg7C4euEo1wI0VUtbr2h07557Oon5eLLgaTSOzjbo3q2bKXBBAJGetSW0JqElZVxTkD+95+KLLxYTPuS+21yIXu2zgEUKbDomd34MiTkxJGbHgLkxgE4yn0+/6vgbus8JMOGv5dCx84NiXkC74vXfYWmVKqbt97HyK6NPAB1e+5kmgKYExZFhqvsg2MXu+XyA6UooFi5X4oaPYUUQoPB9b9eQ154b9R4BoAbaEID587ih9Jxwai5Ch1FagAZsaDKINMHWLVtMAdPWbGoadJ6jhNy4cWPRu7edv7f5lnsN/3T99Zg8ebKYCOze5VwUTg0k2HQu0gp1wPXiQJyqRs/o7OLN/5JCB1kXzAzwat8APXo+jvdVr4rc5va3iYEfXt5SlEZg+Lk4hp+TUC9gOc0FrEiLFaxJi2E5SaovAZap3+VpSuhaiIqjZJmSnHIxrIgFWH1CE8R3FYuTQDQgIaBZTXaA9gD3733bwIRjzx0twaaDP580SSwKoWFeWrGjHQ0QETEcYE2+5T056ibqs4KNhmBTwE8NfMqcQdy7xx3I/1cALAywcEyAt58M8Gy3Cni4c0P06HQ6HupyIXo+cBV6P3gj+vRoi95dr8ajD12L9u0uQffuPczO5sLJU7A6NYYVhAcrc4lJMuyU6GeEj8JtRWoMa9PEb0FQ9GasYP+7MRSNi6HoTSV0zUX7v8We+35K9r4VQ+HYGHaPClCyog+bJmYEMMCGN4eEa3K4CQmRxiODG95qAXJkvVMbTusB6FgX7Tq0by9mCck5pPI0ABmSNJkjwil/agKoC0mud+9eYsSR3ODnnsIDNwR4tGsL9H+sB8aM+wDTv8nB2vU7sWM3sF8mGXJfz5gjTil97fUx4r7o01NQ+HqAYiprH5NkWEU908/HxSAwHxMrCBLfpBSINmhWChIk33gyMyb9yyoqHr6JITE1FfGd30gSsO6grqE+0A7YEQBwEjjAq2vbZjMyMGKQo7+LJaBpMiiHzvNR7tFHHxEnhJBz3+dqgNtuuw3/VLuiuevXr59Y3UOLQPUfUtI/fY0e8wG2y55hyNlja1ySkV1CG0lnL1gPbB2MxFeBxSMZTlTmETg4z1k4wpywD0q+SinAzBTEp0gpSSLxqYchlPG5JyNeskc1BWpcgNdc8csKnJHBJ8DB7AYnTqhZkYVL07BkwRNgNFOn3eLFi1G5cmVs2rRJ3IfIpOIPGPC4OA2MHBmCtKGD3NfTp4vdPk2Ob2K6b9zpNPh3UP4cY1b1Mqgn8cro9+noB8S/ShXlaMpUYVFCwvHh/iqs9hdhvPiEeckUjwAlU2JOYn6C0ZIa4adkWgriXwZI5NyqmgK1RVt9cGS7HwFqMm1Rahq+v9IANLhCM220NHzhggXCT/fjb7zhBmc0z5CI2RC0EuiEpk0FyOvWrhW7eai7RotAyYik4WC61u03d5xQXDPZfMoDtLYW7MDWLblIzPsN4v9m4HNQuR/9atwYISIrcekE0EKgSmDti0oBOkoIfHEdEx+R2DTM2AOl1uSySERcSwSlMUJhJIB0PAuN0um9+uQoLjmy4s8680wxISTO6jHAuVqAtEizZqeKcYNTTj5ZrPN7VW3pojEGWnD6aN9HRXeRloPTDGPx3r0mPcd24d8kiKZWDq1uh/gXEvzSK6BXuzmOX7EK7VXsMAGYWvFfYBJO9mJGFicMkYBkSoAEpVEwwbMHLHiGFOysAV7zOcDGCGTA2MJ0+/+2lknwqGbSsvAnBjyBTZs2Cj9OEEqzY8eOYsqYrPm83DxLKtZO0zzChIkTnO1kBQXbUK1qVdGckKM1AbQYhDZ/PPTQQ2LgiVYBiYEmTgKdVxLKz4YnUfIlgR9zytkv/8hnfq33RYVTlT5MAD9hCW6qVSsRmUiuHVJdEnxdA4nd8+xOIs5+DqJuH0NhPNGFx0UTgKfLgKOhWloZTOMAW9Q4gHwu36kdTRlnNcoyBzppkkSt7SM/mgKmfwOhPYdPDxwolpJTGnTULO1Ivv/++8U+QRqM4qt8nHzSe/LHooTa/CkEvtXE9tota6f2+7/JRBNgWionQKxs4CYlgQo7LZxJTQKyZuMzMxHfk2NIkBRkv5sXodYdTaDj+ORQwGkD65NPPsbQF4aKhSB64sYnEDla168PbLI1Vj6jv4mhmq+HjMnRoQ40lkAriKmJoRHBjh3vFpNLI0eNEptSNcFMnsy3qHV+BR8hPrWcqCyiHH0JEYDdezU8MgyLKwngaACpbsKRfb9SxMko92fPiATfZCO+Z6VqDhSYvFA8oHnPwSFMJNhh0WmTo/X4tNyLloUXbJPTvlGOAKPpY3Ic/I3ffy9UuT3EwWoFIszaNWuddHxnyGyaNVXzCz5FfGqFMoLP721Z+01yaWHdJmBGBJiRiUWomlBYLzyJ+RClCSaTJmiIROECaxhyEDmYupCYn2NEhsL6Ymsauc8++1Rs86KNHLSun55Tv/vLL78UYwRk0VP3kIZ7aU2fcGoHETkihj59VGsWnXb79h0wadIkGUXn2Rcn/wlZ87d9KMGnyqGbTFNePgFcSWa3STL4wCcjgGMDyET9BMsiyeOpTJiPS0F8coDE9FpIbP883EX0QeV+foFG2Aq6gLkhqB39YTSdB/i7Fi3E2T2XX3EFrrziSmGxkz8tG6PRPprupWaAHG3x0o62fY0ZI0foJLksAaidp/P+zDMfeP5dCXm8SzzvNVk2yWr+NMJDg52EAKUCbkHneOAbgUdBQF0BSwCbaNmB9f34Mz9DnpAmmJKGxOaRkgRq3sDZXKJ7DBrsKDKwwnXJYNt+SotWBdHpIPQHULRDmIaC9ZZs7miLF7XjZL23a9tWhKcDHmn+4KSTT8YnH38iwpkDpBXB6OyBc889127zjiCB+KVnVPO/668GeXTNjwLflifhIzGyWMlrFUZoglLKm0kkAQ5PfJDZr6O+/HhKiPmkDVbfi0Riv2kSNIhRbb4hgScOOVTt1Ee602YLGrShdYFRjshAmz2ob09agHoKNE08f/58MfhDM3y0kojGD4gg3DDUQnYBWfy0sIT+OJKczYsiNgFfsgvxFTeqQR5e832VHy5jTQC33KP8I8qaCQ0LOwQQ/UYWILLWm8EdV8TLnUyra+Mn/d00eXg5WBSffyYSexYrErCuogE1QvxegFfbyD377HNicEc7OrqN9vdp441G8Egz0F+5Ud+9LI6rf01A7dauWSPmBOjUcROWtBtd75qJ+NyTpPabFgvV+NKI4OKTihLx3C/XaLEEkYKZ1Oz4BBAkODh7QqIz7PhrlSWvZTj9USyeeZ4qC2V6FSQ2DjFqUqpRr3fACGEMKk4SBsiBkgPi6Bfaj69d/379xXYscmT40ekcfF5AO7+GG4KZe6bilZ/u6tFg0hv6jyTF6n4a4Hka8anlFfjc0POveXOgy4kAV2VVasVyMYi+9kcCZ3AN4Ab0E/fvo1/AgHZA9ojisF7504ARFdDC85Cg2sKJ4Nd+LpwcChDdTWvVqqWYAKKaT5staA+AdgRU9we7S6CUpU/j/LQrh//jJzcodfrazx8coqlhagZmzVa7pXbPQnzhuVLLUZOnyyWpuOVCNV3UdqesXBLIsisNE9e/FAIcuuh4TnwOtCOMuc5HeYVAJKDwq+5Boni9NRKNRrAqmIBwNIG6J38Ch9r9a6+7VqzZoz16dC4f2QQkdFz8SSedKP4LiByN3HXu1EmQhRyN8NG4QXFxsQOy73I3bxbDvESoM866AGPf/gxIbEF8dRfEp6bZWi8qR+mAh8pElJXWzspfX3ugCwx8vwhiRHYDQxGTgRsptkvisDNEBH6f7Fp9ONUWGhP/+hjE1/VGovh7phHsVuwo7cAJoR2N0tHBC7ThgraD0bp7Ap5G7Og/A7p17y5sASIMGXTkPnj/fXTr1lVc04QOzQ3QEO/ECRPETmPaGv7HP16J1q0vQvtb78aIkW+hYMtqYMcQxGfUsbXeB5WB65QVC2fKXJUh76UZ0WP+ThmHsfTHb5gNkBqeCwiBxjMbJQzwUDo6LZ157uen4b1PFwYVIBXk17UQX3M/4nuWGiKUmHUGnh1giCDJwdV5lCNC0ITNZZdeKk4Jo94AjRHQQY+0h4DO+yFDkjaV0C4j6hbSqp2RI1/F7HkrsVsojAJg5zPAnAYyv3pgR4Dr1fRQ2dnnRuU75SjDivJT2tpUOD7xEyrXKCEN4BmBToAosKP8kjxPri2SgR8R16sNMn3ZZYxPK4/4sj8ivuU9xA/stFpBNBF8zQHTDIwcvBsprtWybu3ITqCpYlozSEL9+pwVOWIYmP9xtHHFU4DVHVAyvYoFnpeJU+s1AdivFv6tCnRelm5Xzys7b/aPkyMU1mkCiADUJ+QFH4rgS3iw6OASkW6yd/m1JVR4iggksxogvvIuJLZ+hPi+LZYMhhCeAamJwEjgkqV0TSFcvBDx7V8ivrYr4nNOQAnlgxt4+tuc/LNrp0yk2B4TI05ZRAHMp38jmwQhtrwZAVJdAigpU2b8F5UWlkmYPLxp4AXnizSGJAnUx1BtIztBzC/UQXzJpUh89yQS279AvHijJIBuLjg5Iu4jhUi0Lw/xnVMRp+7piusQn93QNkuitquJNKemJyOB/+22bY8um6hy8yqOB75PgKh41ATIXoDWADrTSV8aFueZ//ER4aPEVfnJCi6Jv5+eBoUIQdczaiA+txniS69GfE1XCWD+24hvm4DEjqlI7JqL+O4FiNPvjmmIF3yB+JZ/IE6rl9b1RHzFn1AyvwXiM2tLoCltMXytBnF8IJLm1f+2cBk54y8Rz12J+P4k4Jv0GMlIZDeQ1gMchADmA3x//wX+x/phShOn4CLyEiKCG1d0kcwzndeYBEoDx0UsuFDDsFMCsQCD1LhQ5Vo02Casni6X3ygHZdS98w0R5eDk3fePKNuIby1hq4OkgRiOlxR8k1crhgA0HmyaAO/FtlDpuftCp4ngH2Y+Kkn4qMxFSZnCaTB4obPCLyU/EtAAJUQAAtgBWb/Xjae/Qb6Pp8XH4uV9KA/8W3QYJz+eePFC5ee835MoIjjppAIzonoB/KWaAEkTiYijEjcgRKk1P03uHxXG8xfvNnn0QJ8eUfB+eiZdRhxPPWrxC53f64LkcUXt1M/8vEWQxn/fIQtLz8+rK2EiuzaA3w30JVkhJn0W8eG++PGFRIQ3YaLS898TUdB++jyP4rlOz0tbx438XhU2ouAFAUL54fkKA+8Qx3+XuY9asVVWkQSw6ctxAGUD2IEgLqEMRRUGfxb53CtUH5hQGl7YSOFhePq8kCPe5b/PyR/XHkny7L3TGahhUmrtV8O5vLmIBp+9P+IdSf1LEx3HGQkkApAN4I8ERoi2BxL6w0WCxEqa0nQzxdMx15GFyd7hFLAXhnf/HH+3YJMVuvsepQ6dNKJFgsnicfHUqk2bf090XkorZ7csIvLvi/f8oGkrcQeCIjRAZGKmMPiLwwQ4qPgfx+P6/qUJb/NNfA0QuzbA+Pc6DE9X3peqxkPpRuTNSY+9wy9XnncnLS9fXhjdK0j2/GByaDYAF+fDfD9278cz4hWICRvxQTxMUmH5cPLoA2fFqOBQWn66Op9R18zPeacfn/l5ZWFANOL3Qrx4Tho6rJ+GJxHvJbHTwYdDgCg/X/QHRhaM66drhNvtTHJdSjqh56F2XYY13biIZ9H+pYVR15FNkB8mouwcOQiYhyW8ybYiMKclYdQOmIGgUGRPSgsTKpSoe1/8NlSKnPuOsB+cdHn6Ue/x/dVvKE1NlGRx/Xfp+Oy5k1c/DkvXV/8HE57fMomXF+bnSxICKKOOG3cUwSkYm4gAiQ86RH30wcTPXLJnTrwogEoR/x06/056EfEcYWF4fnxV7qflhbVSxtoeGTdCTF4ingnh2LImID41tVAcEDFTrhQtk1BYLXTyFb/nYfx4vvhxkklpYWalSvH9D1nKmEZUnvn3+8/0cz8clduMWPJ4UX7+Mz8Mv/ef+3HmCmIUBvGpKWvppAhSB45Md6VkWqwgLoSuUwpKpsSExIWk2F/xTIlJL1ZQQunwtFU6/nvEu3w/P1ySPIq4SfzLFJ/5i2/k5eHf83weJFzUc1lGsgyFsHj8l6dF75M4aD9+Hf0Og4mXrsJ87f8DfvOLmSy41r0AAAAASUVORK5CYII=';
  const app = document.getElementById('app');

  // ───────── DOM helper ─────────
  function h(tag, props) {
    const e = document.createElement(tag);
    const kids = Array.prototype.slice.call(arguments, 2);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    kids.flat().forEach((kid) => { if (kid == null || kid === false) return; e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); });
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  // ───────── i18n ─────────
  const I18N = {
    vi: {
      brand: 'nghienducchua', login_sub: 'Khu vực quản trị — chỉ dành cho chủ sở hữu',
      email: 'Email', password: 'Mật khẩu', totp: 'Mã 2FA (nếu bật)', login: 'Đăng nhập',
      bootstrap: 'Khởi tạo lần đầu', admin_key: 'ADMIN_KEY (khởi tạo)', create_owner: 'Tạo tài khoản chủ',
      logout: 'Đăng xuất', loading: 'Đang tải…', error: 'Lỗi', saved: 'Đã lưu', confirm_delete: 'Xoá vĩnh viễn? Không thể hoàn tác.',
      nav_dash: 'Tổng quan', nav_system: 'Hệ thống', nav_users: 'Người dùng', nav_pay: 'Thanh toán',
      // dashboard
      total_users: 'Tổng người dùng', new_30d: 'Mới (30 ngày)', plan_dist: 'Phân bố gói', api_keys: 'API keys',
      keys_active: 'đang chạy', keys_exhausted: 'hết hạn mức', credits_req: 'Lượt gọi API (đã dùng / tổng)',
      credits_tok: 'Token (đã dùng / tổng)', revenue: 'Doanh thu (đã thanh toán)', audit: 'Nhật ký quản trị', paid_count: 'Đơn đã trả',
      // system
      health: 'Tình trạng hệ thống', worker: 'Worker', supabase: 'Supabase', providers: 'Nhà cung cấp', add_key: 'Thêm API key',
      provider: 'Nhà cung cấp', label: 'Nhãn', secret: 'API key / secret', requests: 'Lượt gọi', tokens: 'Token', priority: 'Ưu tiên',
      status: 'Trạng thái', actions: 'Thao tác', add: 'Thêm', add_credit: 'Thêm hạn mức', disable: 'Tắt', enabled: 'Bật',
      reset_interval: 'Chu kỳ reset', interval_none: 'Không', interval_daily: 'Hàng ngày', interval_weekly: 'Hàng tuần',
      add_credit_req: 'Thêm bao nhiêu LƯỢT GỌI?', add_credit_tok: 'Thêm bao nhiêu TOKEN?', session_warning: 'Kết nối qua session (rủi ro ToS) — mặc định TẮT',
      groq_env: 'Groq keys (biến môi trường)', deepl: 'DeepL', openrouter: 'OpenRouter',
      // translation settings
      trans_settings: 'Cấu hình dịch (gói trả phí)', trans_paid_provider: 'API dịch cho gói TRẢ PHÍ', trans_free_source: 'Gói FREE dịch bằng',
      trans_free_youtube: 'Miễn phí (YouTube/Google)', trans_note: 'User free luôn dùng dịch miễn phí. User trả phí dùng API chọn ở đây (lấy key từ pool bên dưới).',
      trans_provider: 'API dịch', trans_default_sys: 'Theo hệ thống', premium_translate: 'Ép dịch API',
      // users
      search_user: 'Tìm theo email…', plan: 'Gói', model_source: 'Nguồn chấm', created: 'Ngày tạo', ban: 'Cấm', unban: 'Bỏ cấm',
      banned: 'Đã cấm', delete: 'Xoá', detail: 'Chi tiết', usage_30d: 'Sử dụng 30 ngày', src_server: 'Server (API)', src_local: 'Local (Whisper)', src_dedicated: 'API riêng',
      // payments
      payout_cfg: 'Thông tin nhận tiền', beneficiary: 'Tên người nhận', iban: 'IBAN', bic: 'BIC', bank: 'Tên ngân hàng',
      paypal: 'Link PayPal donate', sepay_acc: 'Số tài khoản SePay', sepay_bank: 'Mã ngân hàng SePay', iban_prefix: 'Tiền tố mã IBAN',
      sepay_prefix: 'Tiền tố mã SePay', price_table: 'Bảng giá (JSON)', save: 'Lưu', create_order: 'Tạo đơn',
      method: 'Phương thức', amount: 'Số tiền', currency: 'Tiền tệ', user_id_opt: 'User ID (tuỳ chọn)', orders: 'Đơn thanh toán',
      ref_code: 'Mã tham chiếu', mark_paid: 'Đánh dấu đã trả', order_instructions: 'Hướng dẫn chuyển khoản', reference: 'Nội dung CK',
      pending: 'Chờ', paid: 'Đã trả', theme: 'Sáng/Tối', lang: 'Ngôn ngữ', none: '—',
      // security (đổi mật khẩu + 2FA)
      security: 'Bảo mật tài khoản', change_password: 'Đổi mật khẩu', old_password: 'Mật khẩu hiện tại',
      new_password: 'Mật khẩu mới (≥ 10 ký tự)', twofa: 'Xác thực 2 bước (2FA)',
      twofa_on: '2FA đang BẬT', twofa_off: '2FA đang TẮT', twofa_enroll: 'Bật 2FA', twofa_disable: 'Tắt 2FA',
      twofa_secret_hint: 'Mở app Authenticator (Google Authenticator, Authy…), thêm khoá thủ công bên dưới, rồi nhập mã 6 số để xác nhận:',
      twofa_secret_label: 'Khoá bí mật (nhập vào app)', twofa_code: 'Mã 6 số', twofa_verify: 'Xác nhận & bật',
      twofa_reauth: 'Nhập mật khẩu HOẶC mã 2FA hiện tại để xác nhận tắt:', copy: 'Sao chép', copied: 'Đã sao chép',
    },
    de: {
      brand: 'nghienducchua', login_sub: 'Administrationsbereich — nur für den Inhaber',
      email: 'E-Mail', password: 'Passwort', totp: '2FA-Code (falls aktiv)', login: 'Anmelden',
      bootstrap: 'Ersteinrichtung', admin_key: 'ADMIN_KEY (Einrichtung)', create_owner: 'Inhaber-Konto erstellen',
      logout: 'Abmelden', loading: 'Lädt…', error: 'Fehler', saved: 'Gespeichert', confirm_delete: 'Endgültig löschen? Nicht umkehrbar.',
      nav_dash: 'Übersicht', nav_system: 'System', nav_users: 'Nutzer', nav_pay: 'Zahlungen',
      total_users: 'Nutzer gesamt', new_30d: 'Neu (30 Tage)', plan_dist: 'Tarifverteilung', api_keys: 'API-Schlüssel',
      keys_active: 'aktiv', keys_exhausted: 'aufgebraucht', credits_req: 'API-Aufrufe (genutzt / gesamt)',
      credits_tok: 'Token (genutzt / gesamt)', revenue: 'Umsatz (bezahlt)', audit: 'Admin-Protokoll', paid_count: 'Bezahlte Aufträge',
      health: 'Systemzustand', worker: 'Worker', supabase: 'Supabase', providers: 'Anbieter', add_key: 'API-Schlüssel hinzufügen',
      provider: 'Anbieter', label: 'Bezeichnung', secret: 'API-Schlüssel / Secret', requests: 'Aufrufe', tokens: 'Token', priority: 'Priorität',
      status: 'Status', actions: 'Aktionen', add: 'Hinzufügen', add_credit: 'Kontingent +', disable: 'Aus', enabled: 'An',
      reset_interval: 'Reset-Intervall', interval_none: 'Keins', interval_daily: 'Täglich', interval_weekly: 'Wöchentlich',
      add_credit_req: 'Wie viele AUFRUFE hinzufügen?', add_credit_tok: 'Wie viele TOKEN hinzufügen?', session_warning: 'Session-Verbindung (ToS-Risiko) — standardmäßig AUS',
      groq_env: 'Groq-Schlüssel (Umgebung)', deepl: 'DeepL', openrouter: 'OpenRouter',
      trans_settings: 'Übersetzung (zahlende Tarife)', trans_paid_provider: 'Übersetzungs-API (ZAHLEND)', trans_free_source: 'FREE übersetzt mit',
      trans_free_youtube: 'Kostenlos (YouTube/Google)', trans_note: 'Free-Nutzer nutzen kostenlose Übersetzung. Zahlende nutzen die hier gewählte API (Schlüssel aus dem Pool unten).',
      trans_provider: 'Übersetzungs-API', trans_default_sys: 'System-Standard', premium_translate: 'API erzwingen',
      search_user: 'Nach E-Mail suchen…', plan: 'Tarif', model_source: 'Bewertungsquelle', created: 'Erstellt', ban: 'Sperren', unban: 'Entsperren',
      banned: 'Gesperrt', delete: 'Löschen', detail: 'Details', usage_30d: 'Nutzung 30 Tage', src_server: 'Server (API)', src_local: 'Lokal (Whisper)', src_dedicated: 'Eigene API',
      payout_cfg: 'Zahlungsempfänger', beneficiary: 'Empfängername', iban: 'IBAN', bic: 'BIC', bank: 'Bankname',
      paypal: 'PayPal-Spendenlink', sepay_acc: 'SePay-Kontonummer', sepay_bank: 'SePay-Bankcode', iban_prefix: 'IBAN-Code-Präfix',
      sepay_prefix: 'SePay-Code-Präfix', price_table: 'Preistabelle (JSON)', save: 'Speichern', create_order: 'Auftrag erstellen',
      method: 'Methode', amount: 'Betrag', currency: 'Währung', user_id_opt: 'User-ID (optional)', orders: 'Zahlungsaufträge',
      ref_code: 'Referenzcode', mark_paid: 'Als bezahlt markieren', order_instructions: 'Überweisungsdetails', reference: 'Verwendungszweck',
      pending: 'Offen', paid: 'Bezahlt', theme: 'Hell/Dunkel', lang: 'Sprache', none: '—',
      security: 'Kontosicherheit', change_password: 'Passwort ändern', old_password: 'Aktuelles Passwort',
      new_password: 'Neues Passwort (≥ 10 Zeichen)', twofa: 'Zwei-Faktor (2FA)',
      twofa_on: '2FA ist AN', twofa_off: '2FA ist AUS', twofa_enroll: '2FA aktivieren', twofa_disable: '2FA deaktivieren',
      twofa_secret_hint: 'Öffne eine Authenticator-App (Google Authenticator, Authy…), füge den Schlüssel unten manuell hinzu und gib den 6-stelligen Code ein:',
      twofa_secret_label: 'Geheimschlüssel (in App eingeben)', twofa_code: '6-stelliger Code', twofa_verify: 'Bestätigen & aktivieren',
      twofa_reauth: 'Passwort ODER aktuellen 2FA-Code zum Deaktivieren eingeben:', copy: 'Kopieren', copied: 'Kopiert',
    },
  };
  let lang = localStorage.getItem('admin_lang') || 'vi';
  const t = (k) => (I18N[lang] && I18N[lang][k]) || (I18N.vi[k]) || k;
  function setLang(l) { lang = l; localStorage.setItem('admin_lang', l); document.documentElement.lang = l; render(); }
  const nf = () => new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'vi-VN');
  const fmt = (n) => nf().format(Number(n) || 0);
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString(lang === 'de' ? 'de-DE' : 'vi-VN') : '—';

  // ───────── theme ─────────
  function setTheme(th) { document.documentElement.dataset.theme = th; localStorage.setItem('admin_theme', th); }
  setTheme(localStorage.getItem('admin_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  // ───────── session + api ─────────
  const getToken = () => sessionStorage.getItem('admin_token') || '';
  const setToken = (tk) => { tk ? sessionStorage.setItem('admin_token', tk) : sessionStorage.removeItem('admin_token'); };
  async function api(path, body) {
    const r = await fetch(WORKER + '/admin/' + path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
      body: JSON.stringify(body || {}),
    });
    let data = {}; try { data = await r.json(); } catch (_) {}
    if (r.status === 401 && path !== 'login' && path !== 'bootstrap') { setToken(''); render(); throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(data.error || ('http_' + r.status));
    return data;
  }
  function toast(msg, bad) {
    const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
    document.body.append(el); requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, 2400);
  }

  // ───────── LOGIN ─────────
  function renderLogin() {
    let bootMode = false;
    const errEl = h('div', { class: 'login-err' });
    const email = h('input', { type: 'email', autocomplete: 'username' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const totp = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code' });
    const adminKey = h('input', { type: 'password' });
    const akField = h('div', { class: 'field', style: 'display:none' }, h('label', null, t('admin_key')), adminKey);
    const submitBtn = h('button', { class: 'btn btn--primary', style: 'width:100%', type: 'submit' }, t('login'));
    const bootLink = h('a', { href: '#', onclick: (e) => { e.preventDefault(); bootMode = !bootMode; akField.style.display = bootMode ? '' : 'none'; submitBtn.textContent = bootMode ? t('create_owner') : t('login'); } }, t('bootstrap'));

    async function submit(e) {
      e.preventDefault(); errEl.textContent = ''; submitBtn.disabled = true;
      try {
        if (bootMode) {
          await api('bootstrap', { email: email.value.trim(), password: pass.value, admin_key: adminKey.value });
          toast(t('saved')); bootMode = false; akField.style.display = 'none'; submitBtn.textContent = t('login');
        } else {
          const r = await api('login', { email: email.value.trim(), password: pass.value, totp: totp.value.trim() });
          setToken(r.token); render();
        }
      } catch (err) {
        errEl.textContent = t('error') + ': ' + err.message;
      } finally { submitBtn.disabled = false; }
    }
    const form = h('form', { class: 'login-card', onsubmit: submit },
      h('div', { class: 'login-logo' }, h('img', { src: LOGO_URI, class: 'brand-logo', alt: 'nghienducchua' }), h('span', null, t('brand'))),
      h('div', { class: 'login-sub' }, t('login_sub')),
      h('div', { class: 'field' }, h('label', null, t('email')), email),
      h('div', { class: 'field' }, h('label', null, t('password')), pass),
      h('div', { class: 'field' }, h('label', null, t('totp')), totp),
      akField, errEl, submitBtn,
      h('div', { class: 'login-foot' }, bootLink, h('span', null,
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); setLang(lang === 'vi' ? 'de' : 'vi'); } }, lang === 'vi' ? 'DE' : 'VI'),
        ' · ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); } }, '◐'))));
    clear(app).append(h('div', { class: 'login' }, form));
  }

  // ───────── APP SHELL ─────────
  let currentPage = (location.hash || '#dashboard').slice(1);
  const PAGES = {
    dashboard: { icon: '📊', label: 'nav_dash', render: pageDashboard },
    system: { icon: '⚙️', label: 'nav_system', render: pageSystem },
    users: { icon: '👥', label: 'nav_users', render: pageUsers },
    payments: { icon: '💳', label: 'nav_pay', render: pagePayments },
  };
  function renderShell() {
    const nav = Object.keys(PAGES).map((k) => h('button', {
      class: 'nav-item' + (k === currentPage ? ' on' : ''), onclick: () => { currentPage = k; location.hash = k; route(); closeSidebar(); },
    }, h('span', { class: 'nav-ico' }, PAGES[k].icon), t(PAGES[k].label)));
    const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' },
      h('div', { class: 'brand' }, h('img', { src: LOGO_URI, class: 'brand-logo', alt: 'nghienducchua' }), h('span', null, t('brand'))),
      ...nav,
      h('div', { class: 'sidebar-foot' },
        h('button', { class: 'nav-item', onclick: () => setLang(lang === 'vi' ? 'de' : 'vi') }, h('span', { class: 'nav-ico' }, '🌐'), t('lang') + ': ' + lang.toUpperCase()),
        h('button', { class: 'nav-item', onclick: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') }, h('span', { class: 'nav-ico' }, '◐'), t('theme')),
        h('button', { class: 'nav-item', onclick: doLogout }, h('span', { class: 'nav-ico' }, '🚪'), t('logout'))));
    const view = h('div', { class: 'view', id: 'view' });
    const topbar = h('header', { class: 'topbar' },
      h('button', { class: 'btn btn--ghost burger', onclick: () => document.getElementById('sidebar').classList.toggle('open') }, '☰'),
      h('h1', { id: 'page-title' }, t(PAGES[currentPage].label)));
    clear(app).append(h('div', { class: 'shell' }, sidebar, h('main', { class: 'main' }, topbar, view)));
    route();
  }
  function closeSidebar() { const s = document.getElementById('sidebar'); if (s) s.classList.remove('open'); }
  async function doLogout() { try { await api('logout', {}); } catch (_) {} setToken(''); render(); }
  function setActiveNav() {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('on'));
    const idx = Object.keys(PAGES).indexOf(currentPage);
    const items = document.querySelectorAll('.sidebar .nav-item');
    if (items[idx]) items[idx].classList.add('on');
    const tt = document.getElementById('page-title'); if (tt) tt.textContent = t(PAGES[currentPage].label);
  }
  async function route() {
    setActiveNav();
    const view = document.getElementById('view'); if (!view) return;
    clear(view).append(h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' ', t('loading')));
    try { await PAGES[currentPage].render(view); }
    catch (err) { clear(view).append(h('div', { class: 'empty' }, t('error') + ': ' + err.message)); }
  }

  // ───────── helpers ─────────
  function bar(used, total, klass) {
    const pct = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0;
    return h('div', { class: 'bar' + (pct >= 90 ? ' bar--bad' : pct >= 70 ? ' bar--warn' : '') + (klass ? ' ' + klass : '') }, h('i', { style: 'width:' + pct + '%' }));
  }
  function planBadge(plan) { const p = (plan || 'free').toLowerCase(); return h('span', { class: 'badge badge--' + (p === 'free' ? 'free' : 'pro') }, plan || 'free'); }

  // ───────── PAGE: Dashboard ─────────
  async function pageDashboard(view) {
    const s = await api('stats/overview', {});
    const cards = h('div', { class: 'cards' },
      kpi(t('total_users'), fmt(s.totalUsers), '+' + fmt(s.newUsers30) + ' / 30d'),
      kpi(t('api_keys'), fmt(s.keys.active) + ' ' + t('keys_active'), fmt(s.keys.exhausted) + ' ' + t('keys_exhausted')),
      kpi(t('paid_count'), fmt(s.paidCount), Object.keys(s.revenue || {}).map((c) => fmt(s.revenue[c]) + ' ' + c).join(' · ') || '—'),
      kpi(t('credits_req'), fmt(s.credits.reqUsed) + ' / ' + fmt(s.credits.reqTotal), ''));
    function kpi(label, val, sub) { return h('div', { class: 'card' }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-val' }, val), h('div', { class: 'kpi-sub' }, sub)); }

    const plans = h('div', { class: 'panel' }, h('h2', null, t('plan_dist')));
    const totalP = Object.values(s.planDist || {}).reduce((a, b) => a + b, 0) || 1;
    Object.keys(s.planDist || {}).forEach((p) => {
      plans.append(h('div', null, h('div', { class: 'dist-row' }, h('span', null, p), h('span', null, fmt(s.planDist[p]))), bar(s.planDist[p], totalP)));
    });
    const credits = h('div', { class: 'panel' }, h('h2', null, t('api_keys')),
      h('div', { class: 'dist-row' }, h('span', null, t('credits_req')), h('span', null, fmt(s.credits.reqUsed) + ' / ' + fmt(s.credits.reqTotal))), bar(s.credits.reqUsed, s.credits.reqTotal),
      h('div', { class: 'dist-row' }, h('span', null, t('credits_tok')), h('span', null, fmt(s.credits.tokUsed) + ' / ' + fmt(s.credits.tokTotal))), bar(s.credits.tokUsed, s.credits.tokTotal));

    const audit = h('div', { class: 'panel' }, h('h2', null, t('audit')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
    clear(view).append(cards, h('div', { class: 'grid2' }, plans, credits), audit);
    try {
      const a = await api('audit/list', {});
      const tb = h('table', null, h('thead', null, h('tr', null, h('th', null, 'time'), h('th', null, 'action'), h('th', null, 'target'), h('th', null, 'ip'))));
      const body = h('tbody');
      (a.items || []).slice(0, 30).forEach((r) => body.append(h('tr', null, h('td', null, fmtDate(r.created_at)), h('td', null, r.action), h('td', null, (r.target_type || '') + ' ' + (r.target_id || '')), h('td', null, r.ip || ''))));
      clear(audit).append(h('h2', null, t('audit')), h('div', { class: 'table-wrap' }, tb.appendChild(body) && tb));
    } catch (_) { clear(audit).append(h('h2', null, t('audit')), h('div', { class: 'empty' }, '—')); }
  }

  // ───────── PAGE: System ─────────
  async function pageSystem(view) {
    clear(view);
    // Health
    const healthPanel = h('div', { class: 'panel' }, h('h2', null, t('health')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
    // Keys
    const keysPanel = h('div', { class: 'panel' }, h('h2', null, t('api_keys')));
    const provPanel = h('div', { class: 'panel' }, h('h2', null, t('providers')));
    const addPanel = h('div', { class: 'panel' }, h('h2', null, t('add_key')));
    const transPanel = h('div', { class: 'panel' }, h('h2', null, t('trans_settings')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
    const secPanel = h('div', { class: 'panel' }, h('h2', null, t('security')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
    view.append(healthPanel, transPanel, h('div', { class: 'grid2' }, keysPanel, provPanel), addPanel, secPanel);

    const [health, keys, provs, transCfg, me] = await Promise.all([api('health', {}), api('keys/list', {}), api('providers/list', {}), api('settings/translation/get', {}), api('me', {})]);

    // health render
    const dot = (ok) => h('span', { class: 'health-dot ' + (ok ? 'ok' : 'bad') });
    const hp = h('div', { class: 'panel-row' },
      h('div', null, dot(health.worker && health.worker.ok), t('worker')),
      h('div', null, dot(health.supabase && health.supabase.ok), 'Supabase'),
      h('div', null, h('span', { class: 'badge badge--free' }, t('groq_env') + ': ' + (health.groqEnvKeys || 0))),
      h('div', null, h('span', { class: 'badge ' + (health.deepl ? 'badge--good' : 'badge--free') }, 'DeepL ' + (health.deepl ? '✓' : '✗'))),
      h('div', null, h('span', { class: 'badge ' + (health.openrouter ? 'badge--good' : 'badge--free') }, 'OpenRouter ' + (health.openrouter ? '✓' : '✗'))));
    clear(healthPanel).append(h('h2', null, t('health')), hp);

    // keys table
    function renderKeys(items) {
      const tb = h('table', null, h('thead', null, h('tr', null,
        h('th', null, t('provider')), h('th', null, t('label')), h('th', null, t('status')),
        h('th', null, t('requests')), h('th', null, t('tokens')), h('th', null, t('actions')))));
      const body = h('tbody');
      (items || []).forEach((k) => {
        const reqCell = h('td', null, fmt(k.credit_requests_used) + ' / ' + fmt(k.credit_requests_total), bar(k.credit_requests_used, k.credit_requests_total));
        const tokCell = h('td', null, fmt(k.credit_tokens_used) + ' / ' + fmt(k.credit_tokens_total), bar(k.credit_tokens_used, k.credit_tokens_total));
        const statusBadge = h('span', { class: 'badge ' + (k.status === 'active' ? 'badge--good' : k.status === 'exhausted' ? 'badge--warn' : 'badge--bad') }, k.status);
        const actions = h('td', null, h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn--sm', onclick: async () => {
            const rq = parseInt(prompt(t('add_credit_req'), '0') || '0', 10);
            const tk = parseInt(prompt(t('add_credit_tok'), '0') || '0', 10);
            if (!rq && !tk) return;
            await api('keys/credit', { id: k.id, add_requests: rq, add_tokens: tk }); toast(t('saved')); route();
          } }, t('add_credit')),
          h('button', { class: 'btn btn--sm', onclick: async () => { await api('keys/disable', { id: k.id }); toast(t('saved')); route(); } }, t('disable')),
          h('button', { class: 'btn btn--sm btn--danger', onclick: async () => { if (confirm(t('confirm_delete'))) { await api('keys/delete', { id: k.id }); toast(t('saved')); route(); } } }, t('delete'))));
        body.append(h('tr', null, h('td', null, k.provider_id), h('td', null, k.label || '—'), h('td', null, statusBadge), reqCell, tokCell, actions));
      });
      tb.append(body);
      clear(keysPanel).append(h('h2', null, t('api_keys')), (items && items.length) ? h('div', { class: 'table-wrap' }, tb) : h('div', { class: 'empty' }, '—'));
    }
    renderKeys(keys.items);

    // translation default (provider cho gói trả phí + nguồn gói free)
    {
      const TRANS_PROVS = ['gemini', 'deepl', 'openrouter', 'mistral'];
      const tv = transCfg.value || { paid_provider: 'gemini', free_source: 'free' };
      const provOpts = (transCfg.providers || []).filter((p) => TRANS_PROVS.includes(p.id));
      const list = provOpts.length ? provOpts : TRANS_PROVS.map((id) => ({ id, display_name: id }));
      const paidSel = h('select', null,
        h('option', { value: '', selected: !tv.paid_provider ? 'selected' : null }, '— ' + t('trans_free_youtube') + ' —'),
        ...list.map((p) => h('option', { value: p.id, selected: tv.paid_provider === p.id ? 'selected' : null }, p.display_name + (p.enabled === false ? ' (tắt)' : ''))));
      const freeSel = h('select', null,
        h('option', { value: 'free', selected: (tv.free_source || 'free') === 'free' ? 'selected' : null }, t('trans_free_youtube')),
        ...list.map((p) => h('option', { value: p.id, selected: tv.free_source === p.id ? 'selected' : null }, p.display_name)));
      clear(transPanel).append(
        h('h2', null, t('trans_settings')),
        h('div', { class: 'form-grid' },
          h('div', { class: 'field' }, h('label', null, t('trans_paid_provider')), paidSel),
          h('div', { class: 'field' }, h('label', null, t('trans_free_source')), freeSel)),
        h('div', { class: 'muted', style: 'margin:8px 0' }, t('trans_note')),
        h('button', { class: 'btn btn--primary', onclick: async () => {
          await api('settings/translation/set', { paid_provider: paidSel.value, free_source: freeSel.value });
          toast(t('saved'));
        } }, t('save')));
    }

    // providers
    const pv = h('div');
    (provs.items || []).forEach((p) => {
      pv.append(h('div', { class: 'panel-row', style: 'justify-content:space-between;border-bottom:1px solid var(--border);padding:8px 0' },
        h('div', null, h('b', null, p.display_name), p.kind === 'session' ? h('div', { class: 'muted' }, '⚠️ ' + t('session_warning')) : (p.risk_note ? h('div', { class: 'muted' }, p.risk_note) : null)),
        h('button', { class: 'btn btn--sm ' + (p.enabled ? 'btn--primary' : ''), onclick: async () => { await api('providers/toggle', { id: p.id, enabled: !p.enabled }); toast(t('saved')); route(); } }, p.enabled ? t('enabled') : t('disable'))));
    });
    clear(provPanel).append(h('h2', null, t('providers')), pv);

    // add key form
    const provSel = h('select', null, ...(provs.items || []).map((p) => h('option', { value: p.id }, p.display_name)));
    const labelI = h('input', { type: 'text', placeholder: 'e.g. Gemini #1' });
    const secretI = h('input', { type: 'password', placeholder: 'API key' });
    const reqI = h('input', { type: 'number', value: '0' });
    const tokI = h('input', { type: 'number', value: '0' });
    const prioI = h('input', { type: 'number', value: '100' });
    const intSel = h('select', null, h('option', { value: 'none' }, t('interval_none')), h('option', { value: 'daily' }, t('interval_daily')), h('option', { value: 'weekly' }, t('interval_weekly')));
    clear(addPanel).append(h('h2', null, t('add_key')),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', null, t('provider')), provSel),
        h('div', { class: 'field' }, h('label', null, t('label')), labelI),
        h('div', { class: 'field' }, h('label', null, t('secret')), secretI),
        h('div', { class: 'field' }, h('label', null, t('priority')), prioI),
        h('div', { class: 'field' }, h('label', null, t('requests') + ' (+)'), reqI),
        h('div', { class: 'field' }, h('label', null, t('tokens') + ' (+)'), tokI),
        h('div', { class: 'field' }, h('label', null, t('reset_interval')), intSel)),
      h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn btn--primary', onclick: async () => {
        if (!secretI.value) return;
        await api('keys/add', { provider_id: provSel.value, label: labelI.value, secret: secretI.value, credit_requests_total: +reqI.value || 0, credit_tokens_total: +tokI.value || 0, priority: +prioI.value || 100, reset_interval: intSel.value });
        toast(t('saved')); route();
      } }, t('add'))));

    // ── Bảo mật: đổi mật khẩu + 2FA ──
    renderSecurity(secPanel, !!(me && me.totp_enabled));
  }

  // Panel Bảo mật (đổi mật khẩu + bật/tắt 2FA). twoFAOn = trạng thái hiện tại.
  function renderSecurity(panel, twoFAOn) {
    // — Đổi mật khẩu —
    const oldP = h('input', { type: 'password', autocomplete: 'current-password' });
    const newP = h('input', { type: 'password', autocomplete: 'new-password' });
    const pwBlock = h('div', null,
      h('h2', null, t('security')),
      h('div', { class: 'muted', style: 'margin-bottom:10px;font-weight:700' }, t('change_password')),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', null, t('old_password')), oldP),
        h('div', { class: 'field' }, h('label', null, t('new_password')), newP)),
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn btn--primary', onclick: async () => {
        if (!newP.value || newP.value.length < 10) { toast(t('error') + ': ≥ 10', true); return; }
        try { await api('change-password', { old_password: oldP.value, new_password: newP.value }); oldP.value = ''; newP.value = ''; toast(t('saved')); }
        catch (e) { toast(t('error') + ': ' + e.message, true); }
      } }, t('change_password'))));

    // — 2FA —
    const statusBadge = h('span', { class: 'badge ' + (twoFAOn ? 'badge--good' : 'badge--free') }, twoFAOn ? t('twofa_on') : t('twofa_off'));
    const faBody = h('div');
    const faBlock = h('div', { style: 'margin-top:22px;padding-top:18px;border-top:1px solid var(--border)' },
      h('div', { class: 'panel-row', style: 'justify-content:space-between' },
        h('div', { style: 'font-weight:700' }, t('twofa'), ' ', statusBadge)),
      faBody);

    function paintEnable() {
      clear(faBody);
      const btn = h('button', { class: 'btn btn--primary', style: 'margin-top:12px', onclick: async () => {
        try {
          const res = await api('2fa/enroll', {});
          paintVerify(res.secret);
        } catch (e) { toast(t('error') + ': ' + e.message, true); }
      } }, t('twofa_enroll'));
      faBody.append(btn);
    }

    function paintVerify(secret) {
      clear(faBody);
      const codeI = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '000000' });
      const secretBox = h('input', { type: 'text', value: secret, readonly: true, style: 'font-family:monospace;letter-spacing:1px' });
      faBody.append(
        h('div', { class: 'muted', style: 'margin:10px 0' }, t('twofa_secret_hint')),
        h('div', { class: 'field' }, h('label', null, t('twofa_secret_label')),
          h('div', { class: 'panel-row' }, secretBox,
            h('button', { class: 'btn btn--sm', onclick: () => { try { navigator.clipboard.writeText(secret); toast(t('copied')); } catch (_) { secretBox.select(); } } }, t('copy')))),
        h('div', { class: 'field', style: 'margin-top:10px;max-width:200px' }, h('label', null, t('twofa_code')), codeI),
        h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn btn--primary', onclick: async () => {
          try { await api('2fa/verify', { totp: codeI.value.trim() }); toast(t('saved')); clear(statusBadge).append(t('twofa_on')); statusBadge.className = 'badge badge--good'; paintDisable(); }
          catch (e) { toast(t('error') + ': ' + e.message, true); }
        } }, t('twofa_verify'))));
    }

    function paintDisable() {
      clear(faBody);
      const reauth = h('input', { type: 'text', placeholder: '••••••' });
      faBody.append(
        h('div', { class: 'muted', style: 'margin:10px 0' }, t('twofa_reauth')),
        h('div', { class: 'field', style: 'max-width:280px' }, h('label', null, t('old_password') + ' / ' + t('twofa_code')), reauth),
        h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn btn--danger', onclick: async () => {
          const v = reauth.value.trim();
          // số 6 chữ số → coi là TOTP; còn lại → mật khẩu
          const payload = /^\d{6}$/.test(v) ? { totp: v } : { password: v };
          try { await api('2fa/disable', payload); toast(t('saved')); clear(statusBadge).append(t('twofa_off')); statusBadge.className = 'badge badge--free'; paintEnable(); }
          catch (e) { toast(t('error') + ': ' + e.message, true); }
        } }, t('twofa_disable'))));
    }

    twoFAOn ? paintDisable() : paintEnable();
    clear(panel).append(pwBlock, faBlock);
  }

  // ───────── PAGE: Users ─────────
  async function pageUsers(view) {
    clear(view);
    const searchI = h('input', { type: 'search', placeholder: t('search_user'), style: 'max-width:320px' });
    const panel = h('div', { class: 'panel' });
    view.append(h('div', { class: 'panel-row' }, searchI, h('button', { class: 'btn', onclick: load }, '🔍')), panel);
    let timer;
    searchI.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 350); });
    async function load() {
      clear(panel).append(h('div', { class: 'empty' }, h('span', { class: 'spin' })));
      const r = await api('users/list', { q: searchI.value.trim() });
      const tb = h('table', null, h('thead', null, h('tr', null,
        h('th', null, t('email')), h('th', null, t('plan')), h('th', null, t('model_source')), h('th', null, t('trans_provider')), h('th', null, t('created')), h('th', null, t('actions')))));
      const body = h('tbody');
      const TRANS_PROVS = ['gemini', 'deepl', 'openrouter', 'mistral'];
      (r.items || []).forEach((u) => {
        const planSel = h('select', { class: 'select-inline', onchange: async (e) => { await api('users/set-plan', { user_id: u.id, plan: e.target.value }); toast(t('saved')); } },
          ...['free', 'basic', 'pro', 'lifetime'].map((p) => h('option', { value: p, selected: (u.plan || 'free') === p ? 'selected' : null }, p)));
        const srcSel = h('select', { class: 'select-inline', onchange: async (e) => { await api('users/model-source', { user_id: u.id, model_source: e.target.value }); toast(t('saved')); } },
          ...[['server', t('src_server')], ['local', t('src_local')], ['dedicated', t('src_dedicated')]].map((o) => h('option', { value: o[0], selected: (u.model_source || 'server') === o[0] ? 'selected' : null }, o[1])));
        // API dịch cho riêng user (rỗng = theo hệ thống) + ép dịch API kể cả gói free.
        const transSel = h('select', { class: 'select-inline', onchange: async (e) => { await api('users/translation', { user_id: u.id, translation_provider: e.target.value }); toast(t('saved')); } },
          h('option', { value: '', selected: !u.translation_provider ? 'selected' : null }, t('trans_default_sys')),
          ...TRANS_PROVS.map((p) => h('option', { value: p, selected: u.translation_provider === p ? 'selected' : null }, p)));
        const premBox = h('input', { type: 'checkbox', title: t('premium_translate'), checked: u.premium_translate ? 'checked' : null, onchange: async (e) => { await api('users/translation', { user_id: u.id, premium_translate: e.target.checked }); toast(t('saved')); } });
        const banBtn = h('button', { class: 'btn btn--sm', onclick: async () => { await api('users/' + (u.banned ? 'unban' : 'ban'), { user_id: u.id }); toast(t('saved')); load(); } }, u.banned ? t('unban') : t('ban'));
        const delBtn = h('button', { class: 'btn btn--sm btn--danger', onclick: async () => { if (confirm(t('confirm_delete'))) { await api('users/delete', { user_id: u.id }); toast(t('saved')); load(); } } }, t('delete'));
        body.append(h('tr', null,
          h('td', null, u.banned ? h('span', { class: 'badge badge--bad' }, t('banned') + ' ') : null, u.email || u.id),
          h('td', null, planSel), h('td', null, srcSel),
          h('td', null, h('div', { class: 'panel-row', style: 'gap:6px' }, transSel, h('label', { class: 'muted', style: 'display:flex;align-items:center;gap:3px;font-size:11px' }, premBox, t('premium_translate')))),
          h('td', null, fmtDate(u.created_at)),
          h('td', null, h('div', { class: 'row-actions' }, banBtn, delBtn))));
      });
      tb.append(body);
      clear(panel).append((r.items && r.items.length) ? h('div', { class: 'table-wrap' }, tb) : h('div', { class: 'empty' }, '—'));
    }
    await load();
  }

  // ───────── PAGE: Payments ─────────
  async function pagePayments(view) {
    clear(view);
    const cfgPanel = h('div', { class: 'panel' }, h('h2', null, t('payout_cfg')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
    const orderPanel = h('div', { class: 'panel' }, h('h2', null, t('create_order')));
    const listPanel = h('div', { class: 'panel' }, h('h2', null, t('orders')));
    view.append(cfgPanel, h('div', { class: 'grid2' }, orderPanel, listPanel));

    const { config } = await api('payout-config/get', {});
    const c = config || {};
    const fields = {
      beneficiary_name: h('input', { type: 'text', value: c.beneficiary_name || '' }),
      iban: h('input', { type: 'text', value: c.iban || '' }),
      bic: h('input', { type: 'text', value: c.bic || '' }),
      bank_name: h('input', { type: 'text', value: c.bank_name || '' }),
      paypal_link: h('input', { type: 'text', value: c.paypal_link || '' }),
      sepay_account_number: h('input', { type: 'text', value: c.sepay_account_number || '' }),
      sepay_bank_code: h('input', { type: 'text', value: c.sepay_bank_code || '' }),
      iban_ref_prefix: h('input', { type: 'text', value: c.iban_ref_prefix || 'DE-' }),
      sepay_ref_prefix: h('input', { type: 'text', value: c.sepay_ref_prefix || 'VN-' }),
      price_table: h('textarea', { rows: '4' }, JSON.stringify(c.price_table || {}, null, 2)),
    };
    const labels = { beneficiary_name: 'beneficiary', iban: 'iban', bic: 'bic', bank_name: 'bank', paypal_link: 'paypal', sepay_account_number: 'sepay_acc', sepay_bank_code: 'sepay_bank', iban_ref_prefix: 'iban_prefix', sepay_ref_prefix: 'sepay_prefix', price_table: 'price_table' };
    const grid = h('div', { class: 'form-grid' });
    Object.keys(fields).forEach((k) => grid.append(h('div', { class: 'field' + (k === 'price_table' ? '' : '') }, h('label', null, t(labels[k])), fields[k])));
    clear(cfgPanel).append(h('h2', null, t('payout_cfg')), grid,
      h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn btn--primary', onclick: async () => {
        const payload = {};
        Object.keys(fields).forEach((k) => { payload[k] = k === 'price_table' ? safeJson(fields[k].value) : fields[k].value; });
        await api('payout-config/update', payload); toast(t('saved'));
      } }, t('save'))));
    function safeJson(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

    // create order
    const oUser = h('input', { type: 'text', placeholder: 'uuid' });
    const oMethod = h('select', null, h('option', { value: 'iban' }, 'IBAN (DE)'), h('option', { value: 'sepay' }, 'SePay (VN)'), h('option', { value: 'paypal' }, 'PayPal'));
    const oPlan = h('select', null, ...['basic', 'pro', 'lifetime'].map((p) => h('option', { value: p }, p)));
    const oAmount = h('input', { type: 'number', value: '0' });
    const oCur = h('select', null, h('option', { value: 'EUR' }, 'EUR'), h('option', { value: 'VND' }, 'VND'));
    const oOut = h('div');
    clear(orderPanel).append(h('h2', null, t('create_order')),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', null, t('user_id_opt')), oUser),
        h('div', { class: 'field' }, h('label', null, t('method')), oMethod),
        h('div', { class: 'field' }, h('label', null, t('plan')), oPlan),
        h('div', { class: 'field' }, h('label', null, t('amount')), oAmount),
        h('div', { class: 'field' }, h('label', null, t('currency')), oCur)),
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn btn--primary', onclick: async () => {
        const r = await api('payments/create-order', { user_id: oUser.value.trim(), method: oMethod.value, plan: oPlan.value, amount: +oAmount.value || 0, currency: oCur.value });
        const ins = r.instructions || {};
        clear(oOut).append(h('div', { class: 'note' },
          h('div', null, t('ref_code') + ': ', h('code', null, r.reference_code)),
          h('div', { style: 'margin-top:6px' }, t('order_instructions') + ':'),
          h('pre', { style: 'white-space:pre-wrap;margin:6px 0 0' }, Object.keys(ins).map((k) => k + ': ' + ins[k]).join('\n'))));
        toast(t('saved')); loadOrders();
      } }, t('create_order'))), oOut);

    // orders list
    async function loadOrders() {
      clear(listPanel).append(h('h2', null, t('orders')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
      const r = await api('payments/list', {});
      const tb = h('table', null, h('thead', null, h('tr', null, h('th', null, t('ref_code')), h('th', null, t('method')), h('th', null, t('plan')), h('th', null, t('amount')), h('th', null, t('status')), h('th', null, t('actions')))));
      const body = h('tbody');
      (r.items || []).forEach((p) => {
        const st = h('span', { class: 'badge ' + (p.status === 'paid' ? 'badge--good' : 'badge--warn') }, p.status === 'paid' ? t('paid') : t('pending'));
        const act = p.status === 'paid' ? h('span', { class: 'muted' }, fmtDate(p.paid_at)) : h('button', { class: 'btn btn--sm btn--primary', onclick: async () => { await api('payments/mark-paid', { id: p.id }); toast(t('saved')); loadOrders(); } }, t('mark_paid'));
        body.append(h('tr', null, h('td', null, p.reference_code), h('td', null, p.method), h('td', null, p.plan || '—'), h('td', null, fmt(p.amount) + ' ' + p.currency), h('td', null, st), h('td', null, act)));
      });
      tb.append(body);
      clear(listPanel).append(h('h2', null, t('orders')), (r.items && r.items.length) ? h('div', { class: 'table-wrap' }, tb) : h('div', { class: 'empty' }, '—'));
    }
    await loadOrders();
  }

  // ───────── boot ─────────
  function render() { if (getToken()) renderShell(); else renderLogin(); }
  window.addEventListener('hashchange', () => { const p = (location.hash || '#dashboard').slice(1); if (PAGES[p]) { currentPage = p; if (getToken()) route(); } });
  render();
})();
